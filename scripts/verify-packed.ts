// Packed-tarball verification (workstream 7): proves the npm artifact works
// without the checkout.
//
//   bun scripts/verify-packed.ts [--keep]
//
// Steps: npm pack, record the tarball sha256, install the tarball into a
// temp directory outside the repo, scaffold every template non-interactively
// through the installed bin shim, assert no placeholders or repo paths leak
// into generated projects (paths and contents, re-scanned after extension
// installs), prove the shipped lockfiles govern installs (--frozen-lockfile,
// bytes unchanged), prove a tampered vendored client fails the scaffold-time
// checksum, run each fixture's acceptance (install, test, check, build,
// artifacts), extension add/remove cycles restoring the scaffold byte for
// byte, and tarball failure paths. Any failure exits 1 naming the step;
// temp directories are cleaned unless --keep.
//
// Needs network (bun install in fixtures) and the repo's Bun toolchain.
// Container/image acceptance stays in CI; this script covers everything
// before docker.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const KEEP = process.argv.includes("--keep");
const TEMPLATE_IDS = ["full-stack", "web", "static", "blog"] as const;
type TemplateId = (typeof TEMPLATE_IDS)[number];

class VerifyError extends Error {
  constructor(step: string, detail: string) {
    super(`[${step}] ${detail}`);
  }
}

function fail(step: string, detail: string): never {
  throw new VerifyError(step, detail);
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string[], cwd: string): RunResult {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

function must(step: string, cmd: string[], cwd: string): RunResult {
  const result = run(cmd, cwd);
  if (result.code !== 0) {
    fail(step, `\`${cmd.join(" ")}\` exited ${result.code}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".astro", "data"]);

interface Tree {
  files: string[];
  dirs: string[];
}

function walkTree(dir: string, out: Tree = { files: [], dirs: [] }): Tree {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) {
      // Generated projects must not contain symlinks at all.
      fail("walk", `unexpected symlink in generated output: ${full}`);
    }
    if (info.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) {
        out.dirs.push(full);
        walkTree(full, out);
      }
    } else {
      out.files.push(full);
    }
  }
  return out;
}

// Content digest of a fixture, ignoring build/install output, to prove the
// extension remove path restores the scaffold byte for byte. Directories are
// recorded too (a leftover empty directory fails the restore), and every
// record is length-framed so path/content repartitions cannot collide.
function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const tree = walkTree(root);
  for (const dir of tree.dirs) {
    const rel = relative(root, dir);
    hash.update(`D${rel.length}:${rel}|`);
  }
  for (const file of tree.files) {
    const rel = relative(root, file);
    const bytes = readFileSync(file);
    hash.update(`F${rel.length}:${rel}|${bytes.length}:`);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

// Byte-level scan, binaries included: a repo path baked into a PNG is as
// much of a leak as one in source.
function assertNoLeaks(step: string, fixtureDir: string, forbidden: string[]): void {
  const needles = forbidden.map((needle) => Buffer.from(needle));
  for (const file of walkTree(fixtureDir).files) {
    const rel = relative(fixtureDir, file);
    for (const needle of forbidden) {
      if (rel.includes(needle)) fail(step, `path "${rel}" contains "${needle}"`);
    }
    const bytes = readFileSync(file);
    for (const needle of needles) {
      if (bytes.includes(needle)) fail(step, `${rel} contains "${needle}"`);
    }
  }
}

function main(): void {
  // Nothing may be written before this guard: a TMPDIR inside the checkout
  // would let temp trees (and their node_modules) shadow the real repo.
  const tempRoot = resolve(tmpdir());
  if (tempRoot === REPO || tempRoot.startsWith(REPO + sep)) {
    fail("workdir", `TMPDIR ${tempRoot} is inside the checkout; set TMPDIR elsewhere`);
  }

  // 1. Pack --------------------------------------------------------------------

  const packDir = mkdtempSync(join(tmpdir(), "shibumi-pack-"));
  cleanupDirs.push(packDir);
  const packResult = must("pack", ["npm", "pack", "--pack-destination", packDir], REPO);
  const tarballName = packResult.stdout.trim().split("\n").at(-1) ?? "";
  const tarball = join(packDir, tarballName);
  if (!tarballName.endsWith(".tgz") || !existsSync(tarball)) {
    fail("pack", `npm pack did not produce a tarball (got "${tarballName}")`);
  }
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  console.log(`Tarball: ${tarballName}`);
  console.log(`sha256:  ${digest}`);

  // 2. Install the tarball outside the repo -------------------------------------

  const workDir = mkdtempSync(join(tmpdir(), "shibumi-packed-"));
  cleanupDirs.push(workDir);
  const toolDir = join(workDir, "tool");
  mkdirSync(toolDir);
  writeFileSync(
    join(toolDir, "package.json"),
    `${JSON.stringify({ name: "packed-verify", private: true }, null, 2)}\n`
  );
  must("install-tarball", ["bun", "add", tarball], toolDir);
  const packageDir = join(toolDir, "node_modules", "create-shibumi");
  // The bin shim is what `bunx create-shibumi` runs; a broken bin mapping
  // must fail here, so nothing below calls src/cli.ts directly.
  const cli = join(toolDir, "node_modules", ".bin", "create-shibumi");
  if (!existsSync(cli)) fail("install-tarball", "bin shim node_modules/.bin/create-shibumi missing");
  console.log(`Installed into ${toolDir}`);

  const helpProbe = must("bin-shim", [cli, "--help"], toolDir);
  if (!helpProbe.stdout.includes("create-shibumi") || !helpProbe.stdout.includes("Usage")) {
    fail("bin-shim", "--help output unrecognizable");
  }

  // The tarball carries both clients and their locks, so a consistent tamper
  // would self-verify; running from the checkout, pin the shipped locks to
  // the repo's known-good copies.
  for (const lock of ["ship.lock.json", "shibumi.lock.json"]) {
    const shipped = readFileSync(join(packageDir, "scripts", lock));
    const known = readFileSync(join(REPO, "scripts", lock));
    if (!shipped.equals(known)) fail("lock-authenticity", `${lock} in the tarball differs from the checkout`);
  }

  // The scaffolds must reference neither the checkout nor the installed
  // package copy, and no template placeholder name may survive.
  const forbidden = [REPO, workDir];
  for (const id of TEMPLATE_IDS) {
    const templatePkg = join(packageDir, "src", "templates", id, "package.json");
    const name = (JSON.parse(readFileSync(templatePkg, "utf8")) as { name?: string }).name;
    if (!name) fail("placeholders", `template ${id} has no package name to check against`);
    forbidden.push(name);
  }

  const fixturesDir = join(workDir, "fixtures");
  mkdirSync(fixturesDir);

  // 3. Tampered vendored clients must fail the scaffold-time checksum -----------

  for (const client of ["ship.ts", "shibumi.ts"]) {
    const step = `tamper:${client}`;
    const clientPath = join(packageDir, "src", "templates", client);
    const original = readFileSync(clientPath);
    writeFileSync(clientPath, Buffer.concat([original, Buffer.from("\n// tampered\n")]));
    try {
      const result = run([cli, "tampered-app", "--yes", "--template", "full-stack", "--no-git", "--no-install"], fixturesDir);
      if (result.code === 0) fail(step, "scaffold succeeded with a tampered vendored client");
      if (!result.stderr.includes("checksum")) {
        fail(step, `expected a checksum error, got:\n${result.stderr}`);
      }
      if (existsSync(join(fixturesDir, "tampered-app"))) {
        fail(step, "failed scaffold left the destination behind");
      }
    } finally {
      writeFileSync(clientPath, original);
    }
    console.log(`tamper rejected: ${client}`);
  }

  // 4. Scaffold and verify every template ----------------------------------------

  function scaffold(id: TemplateId): string {
    const name = `packed-${id}`;
    // --no-install, then --frozen-lockfile below: the shipped lockfile must
    // govern the install, not be silently repaired by it.
    must(`scaffold:${id}`, [cli, name, "--yes", "--template", id, "--no-git", "--no-install"], fixturesDir);
    const dir = join(fixturesDir, name);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    if (pkg.name !== name) fail(`scaffold:${id}`, `package name is "${pkg.name}", expected "${name}"`);
    if (!existsSync(join(dir, ".gitignore")) || existsSync(join(dir, "gitignore"))) {
      fail(`scaffold:${id}`, ".gitignore was not renamed into place");
    }
    if (!existsSync(join(dir, "agents.md"))) fail(`scaffold:${id}`, "agents.md missing");
    if (pkg.scripts?.ship && !existsSync(join(dir, "scripts", "ship.ts"))) {
      fail(`scaffold:${id}`, "ship script declared but scripts/ship.ts not vendored");
    }
    if (pkg.scripts?.shibumi && !existsSync(join(dir, "scripts", "shibumi.ts"))) {
      fail(`scaffold:${id}`, "shibumi script declared but scripts/shibumi.ts not vendored");
    }
    assertNoLeaks(`placeholders:${id}`, dir, forbidden);

    const lockPath = join(dir, "bun.lock");
    const hasDeps =
      Object.keys((pkg as { dependencies?: object }).dependencies ?? {}).length > 0 ||
      Object.keys((pkg as { devDependencies?: object }).devDependencies ?? {}).length > 0;
    if (existsSync(lockPath)) {
      const before = readFileSync(lockPath);
      must(`frozen-install:${id}`, ["bun", "install", "--frozen-lockfile"], dir);
      if (!before.equals(readFileSync(lockPath))) {
        fail(`frozen-install:${id}`, "bun install --frozen-lockfile changed bun.lock");
      }
    } else if (hasDeps) {
      // A template with dependencies must ship its lockfile; a plain install
      // here would silently repair the missing lock and hide the packaging bug.
      fail(`scaffold:${id}`, "template declares dependencies but ships no bun.lock");
    }
    console.log(`scaffolded ${id}`);
    return dir;
  }

  function extensionCycle(id: string, dir: string, extensions: string[]): void {
    const step = `extensions:${id}`;
    const shibumi = ["bun", "run", "shibumi"];
    const before = treeDigest(dir);
    const listed = must(step, [...shibumi, "list"], dir).stdout;
    for (const ext of extensions) {
      if (!listed.includes(`${ext}  available`)) fail(step, `"${ext}" not listed as available`);
    }
    must(step, [...shibumi, "add", extensions[0]!, "--dry-run", "--yes"], dir);
    if (treeDigest(dir) !== before) fail(step, "dry run changed the tree");
    for (const ext of extensions) {
      must(step, [...shibumi, "add", ext, "--yes"], dir);
    }
    // Extension content comes from the same tarball; it must be as leak-free
    // as the scaffold.
    assertNoLeaks(step, dir, forbidden);
    must(step, ["bun", "test"], dir);
    must(step, ["bun", "run", "check"], dir);
    must(step, ["bun", "run", "build"], dir);
    for (const ext of [...extensions].reverse()) {
      must(step, [...shibumi, "remove", ext, "--yes"], dir);
    }
    if (treeDigest(dir) !== before) fail(step, "remove did not restore the scaffold byte for byte");
    console.log(`extension cycle ok: ${id} (${extensions.join(", ")})`);
  }

  for (const id of TEMPLATE_IDS) {
    const dir = scaffold(id);

    if (id === "full-stack" || id === "web") {
      must(`accept:${id}`, ["bun", "test"], dir);
      must(`accept:${id}`, ["bun", "run", "check"], dir);
      must(`accept:${id}`, ["bun", "run", "build"], dir);
      if (!existsSync(join(dir, "dist", "server.js"))) {
        fail(`accept:${id}`, "build did not produce dist/server.js");
      }
      extensionCycle(id, dir, id === "full-stack" ? ["auth", "email"] : ["email"]);
    }

    if (id === "static") {
      for (const artifact of ["public/index.html", "public/404.html", "public/style.css"]) {
        if (!existsSync(join(dir, artifact))) fail("accept:static", `${artifact} missing`);
      }
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };
      if (pkg.scripts["ship:setup"] !== "bun scripts/ship.ts --setup --static --output-dir public") {
        fail("accept:static", `unexpected ship:setup script: ${pkg.scripts["ship:setup"]}`);
      }
      if (pkg.scripts.shibumi) fail("accept:static", "static template must not carry the shibumi script");
    }

    if (id === "blog") {
      must("accept:blog", ["bun", "run", "check"], dir);
      must("accept:blog", ["bun", "run", "build"], dir);
      for (const artifact of [
        "dist/index.html",
        "dist/404.html",
        "dist/rss.xml",
        "dist/sitemap-index.xml",
        "dist/llms.txt",
        "dist/robots.txt",
        "dist/og-default.png",
        "dist/posts/own-your-source/index.html",
        "dist/posts/own-your-source.md",
      ]) {
        if (!existsSync(join(dir, artifact))) fail("accept:blog", `${artifact} missing`);
      }
    }

    console.log(`acceptance ok: ${id}`);
  }

  // 5. Failure paths from the tarball ---------------------------------------------

  const failStep = "failure-paths";
  const conflictDir = join(fixturesDir, "conflict-target");
  mkdirSync(join(conflictDir, "nested"), { recursive: true });
  const sentinel = join(conflictDir, "nested", "keep.txt");
  writeFileSync(sentinel, "must survive\n");
  const existing = run([cli, "conflict-target", "--yes", "--template", "web", "--no-git", "--no-install"], fixturesDir);
  if (existing.code !== 1 || !existing.stderr.includes("already exists")) {
    fail(failStep, `existing-destination scaffold: expected exit 1 naming the conflict, got ${existing.code}:\n${existing.stderr}`);
  }
  if (readFileSync(sentinel, "utf8") !== "must survive\n") {
    fail(failStep, "existing directory contents were touched by a failed scaffold");
  }
  if (readdirSync(conflictDir).sort().join(",") !== "nested") {
    fail(failStep, "failed scaffold wrote into the existing directory");
  }

  for (const flag of ["--nope", "--spa", "--output-dir=dist", "--build-script=build"]) {
    const name = "flag-check";
    const result = run([cli, name, "--yes", "--template", "web", flag], fixturesDir);
    const bare = flag.split("=")[0]!;
    if (result.code !== 2) fail(failStep, `${flag} exited ${result.code}, expected 2`);
    if (!result.stderr.includes(`Unknown flag: ${bare}`)) {
      fail(failStep, `${flag} did not produce the unknown-flag error:\n${result.stderr}`);
    }
    if (existsSync(join(fixturesDir, name))) fail(failStep, `${flag} still scaffolded a project`);
  }
  const leftovers = readdirSync(fixturesDir).filter((entry) => entry.includes("shibumi-tmp"));
  if (leftovers.length > 0) fail(failStep, `failed scaffolds left temp siblings: ${leftovers.join(", ")}`);
  console.log("failure paths ok");

  console.log(`\nPacked verification green.\nTarball sha256: ${digest}`);
}

const cleanupDirs: string[] = [];

function cleanup(): void {
  if (KEEP) {
    if (cleanupDirs.length > 0) console.error(`Directories kept: ${cleanupDirs.join(", ")}`);
    return;
  }
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.error(`could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

try {
  main();
  process.exitCode = 0;
} catch (error) {
  console.error(error instanceof VerifyError ? `FAIL ${error.message}` : error);
  process.exitCode = 1;
} finally {
  cleanup();
}
