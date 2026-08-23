// Packed-tarball verification (workstream 7): proves the npm artifact works
// without the checkout.
//
//   bun scripts/verify-packed.ts [--keep]
//
// Steps: npm pack, record the tarball sha256, install the tarball into a
// temp directory outside the repo, scaffold every template non-interactively
// through the installed package, assert no placeholders or repo paths leak
// into generated projects, run each fixture's acceptance (install, test,
// check, build, artifacts), and run the extension add/remove cycle where the
// template supports it. Any failure exits 1 naming the step. --keep leaves
// the work directory behind for inspection.
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
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const KEEP = process.argv.includes("--keep");
const TEMPLATE_IDS = ["full-stack", "web", "static", "blog"] as const;

let workDir = "";

function fail(step: string, detail: string): never {
  console.error(`FAIL [${step}] ${detail}`);
  if (workDir && KEEP) console.error(`Work directory kept: ${workDir}`);
  process.exit(1);
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
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".ico", ".woff", ".woff2"]);

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walkFiles(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

// Content digest of a fixture, ignoring build/install output, to prove the
// extension remove path restores the scaffold byte for byte.
function treeDigest(root: string): string {
  const hash = createHash("sha256");
  for (const file of walkFiles(root)) {
    hash.update(relative(root, file));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

function assertNoLeaks(step: string, fixtureDir: string, forbidden: string[]): void {
  for (const file of walkFiles(fixtureDir)) {
    if (BINARY_EXTENSIONS.has(file.slice(file.lastIndexOf(".")))) continue;
    const content = readFileSync(file, "utf8");
    for (const needle of forbidden) {
      if (content.includes(needle)) {
        fail(step, `${relative(fixtureDir, file)} contains "${needle}"`);
      }
    }
  }
}

// 1. Pack ---------------------------------------------------------------------

const packDir = mkdtempSync(join(tmpdir(), "shibumi-pack-"));
const packResult = must("pack", ["npm", "pack", "--pack-destination", packDir], REPO);
const tarballName = packResult.stdout.trim().split("\n").at(-1) ?? "";
const tarball = join(packDir, tarballName);
if (!tarballName.endsWith(".tgz") || !existsSync(tarball)) {
  fail("pack", `npm pack did not produce a tarball (got "${tarballName}")`);
}
const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
console.log(`Tarball: ${tarballName}`);
console.log(`sha256:  ${digest}`);

// 2. Install the tarball outside the repo --------------------------------------

workDir = mkdtempSync(join(tmpdir(), "shibumi-packed-"));
const toolDir = join(workDir, "tool");
mkdirSync(toolDir);
writeFileSync(
  join(toolDir, "package.json"),
  `${JSON.stringify({ name: "packed-verify", private: true }, null, 2)}\n`
);
must("install-tarball", ["bun", "add", tarball], toolDir);
const packageDir = join(toolDir, "node_modules", "create-shibumi");
const cli = join(packageDir, "src", "cli.ts");
if (!existsSync(cli)) fail("install-tarball", `installed package has no ${cli}`);
console.log(`Installed into ${toolDir}`);

// The scaffolds must reference neither the checkout nor the installed
// package copy, and no template placeholder name may survive.
const forbidden = [REPO, packageDir];
for (const id of TEMPLATE_IDS) {
  const templatePkg = join(packageDir, "src", "templates", id, "package.json");
  const name = (JSON.parse(readFileSync(templatePkg, "utf8")) as { name?: string }).name;
  if (!name) fail("placeholders", `template ${id} has no package name to check against`);
  forbidden.push(name);
}

// 3. Scaffold and verify every template ----------------------------------------

const fixturesDir = join(workDir, "fixtures");
mkdirSync(fixturesDir);

function scaffold(id: (typeof TEMPLATE_IDS)[number]): string {
  const name = `packed-${id}`;
  must(`scaffold:${id}`, ["bun", cli, name, "--yes", "--template", id, "--no-git"], fixturesDir);
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
  must(step, ["bun", "test"], dir);
  must(step, ["bun", "run", "check"], dir);
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

// 4. Failure paths from the tarball ---------------------------------------------

const failStep = "failure-paths";
const conflictDir = join(fixturesDir, "conflict-target");
mkdirSync(conflictDir);
const existing = run(["bun", cli, "conflict-target", "--yes", "--template", "web", "--no-git"], fixturesDir);
if (existing.code === 0) fail(failStep, "scaffolding over an existing directory succeeded");
if (readdirSync(conflictDir).length !== 0) fail(failStep, "failed scaffold wrote into the existing directory");

const unknownFlag = run(["bun", cli, "flag-check", "--yes", "--template", "web", "--nope"], fixturesDir);
if (unknownFlag.code === 0 || existsSync(join(fixturesDir, "flag-check"))) {
  fail(failStep, "unknown flag was not rejected cleanly");
}
console.log("failure paths ok");

console.log(`\nPacked verification green.\nTarball sha256: ${digest}`);
if (KEEP) {
  console.log(`Work directory kept: ${workDir}`);
} else {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
}
