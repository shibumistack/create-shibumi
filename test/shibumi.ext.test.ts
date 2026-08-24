import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createProject, type Runner } from "../src/create";
import {
  EXTENSIONS,
  applyAdd,
  applyRemove,
  findExtension,
  isInstalled,
  planAdd,
  planRemove,
  runCli,
  type ExtensionBundle,
} from "../src/templates/shibumi";
import { buildBundles, injectBundles } from "../scripts/sync-extensions";

const REPO = join(import.meta.dir, "..");
const TEMPLATES = join(REPO, "src", "templates");
const auth = findExtension("auth")!;
const email = findExtension("email")!;

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "shibumi-ext-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

// Plain copy of a template; enough project for the installer, no install/git.
function fixture(template: "full-stack" | "web"): string {
  const dest = join(work, `fixture-${template}-${readdirSync(work).length}`);
  cpSync(join(TEMPLATES, template), dest, { recursive: true });
  renameSync(join(dest, "gitignore"), join(dest, ".gitignore"));
  return dest;
}

function treeDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        hash.update(relative(root, full));
        hash.update(readFileSync(full));
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}

interface CliRun {
  code: number;
  out: string;
  err: string;
}

async function cli(root: string, argv: string[], confirmAnswer = false): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(
    argv,
    root,
    {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      confirm: async () => confirmAnswer,
    },
    false
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("embedded bundle freshness", () => {
  it("committed shibumi.ts matches a regeneration from src/extensions and the lock", () => {
    const committed = readFileSync(join(TEMPLATES, "shibumi.ts"), "utf8");
    const regenerated = injectBundles(committed, buildBundles());
    expect(regenerated).toBe(committed);
    const lock = JSON.parse(readFileSync(join(REPO, "scripts", "shibumi.lock.json"), "utf8")) as {
      sha256: string;
      extensions: Array<{ name: string; version: string }>;
    };
    expect(createHash("sha256").update(committed).digest("hex")).toBe(lock.sha256);
    expect(lock.extensions).toEqual(EXTENSIONS.map((ext) => ({ name: ext.name, version: ext.version })));
  });

  it("ships auth and email with the contracted requirements", () => {
    expect(auth.requires).toBe("database");
    expect(auth.migration).toContain("CREATE TABLE users");
    expect(auth.deps ?? {}).toEqual({});
    expect(email.requires).toBeNull();
    expect(email.migration).toBeNull();
    expect(email.deps ?? {}).toEqual({});
  });

  it("carries a semver version on every bundle", () => {
    for (const ext of EXTENSIONS) expect(ext.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("versioning and update", () => {
  it("records the installed version and clears it on removal", async () => {
    const root = fixture("full-stack");
    expect((await cli(root, ["add", "auth", "--yes"])).code).toBe(0);
    const lockPath = join(root, ".shibumi", "installed.json");
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toEqual({ auth: auth.version });
    expect((await cli(root, ["remove", "auth", "--yes"])).code).toBe(0);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("update --check reports up to date, then drift after an edit", async () => {
    const root = fixture("full-stack");
    await cli(root, ["add", "auth", "--yes"]);
    const clean = await cli(root, ["update", "--check"]);
    expect(clean.code).toBe(0);
    expect(clean.out).toContain("up to date");

    writeFileSync(join(root, "src", "lib", "auth.ts"), "// user edit\n");
    const drifted = await cli(root, ["update", "--check"]);
    expect(drifted.out).toContain("differ from the bundle");
    expect(drifted.out).toContain("src/lib/auth.ts");
  });

  it("update --check on a project with nothing installed says so", async () => {
    const root = fixture("full-stack");
    expect((await cli(root, ["update", "--check"])).out).toContain("No extensions installed");
  });
});

describe("scaffold vendoring", () => {
  it("copies the checksummed installer into projects whose scripts use it", async () => {
    const okRun: Runner = async () => ({ ok: true, code: 0 });
    const { dest } = await createProject(
      { name: "vend", parentDir: work, template: "full-stack", git: false, install: false, templatesDir: TEMPLATES },
      okRun
    );
    expect(readFileSync(join(dest, "scripts", "shibumi.ts"), "utf8")).toBe(
      readFileSync(join(TEMPLATES, "shibumi.ts"), "utf8")
    );
    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
    expect(pkg.scripts.shibumi).toBe("bun scripts/shibumi.ts");
  });
});

describe("add auth", () => {
  it("installs files, edits, migration, and agents section", () => {
    const root = fixture("full-stack");
    const result = planAdd(root, auth);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.conflicts).toEqual([]);
    expect(result.plan.migrationName).toBe("0003_auth.sql");
    applyAdd(root, auth, result.plan);

    expect(existsSync(join(root, "src", "db", "schema-auth.ts"))).toBe(true);
    expect(existsSync(join(root, "src", "lib", "auth.ts"))).toBe(true);
    expect(existsSync(join(root, "src", "routes", "auth.ts"))).toBe(true);
    expect(existsSync(join(root, "test", "auth.test.ts"))).toBe(true);

    const appTs = readFileSync(join(root, "src", "app.ts"), "utf8");
    expect(appTs).toContain('import { authRoutes } from "./routes/auth";');
    // The mount must come after the security-header middleware registration.
    expect(appTs.indexOf('app.route("/auth", authRoutes);')).toBeGreaterThan(appTs.indexOf('app.use("*"'));

    const dbIndex = readFileSync(join(root, "src", "db", "index.ts"), "utf8");
    expect(dbIndex).toContain('import * as authSchema from "./schema-auth";');
    expect(dbIndex).toContain("drizzle(sqlite, { schema: { ...schema, ...authSchema } });");

    expect(readFileSync(join(root, "src", "db", "migrations", "0003_auth.sql"), "utf8")).toBe(auth.migration!);
    expect(readFileSync(join(root, "agents", "auth.md"), "utf8")).toBe(auth.agentsFile);
    const agentsMd = readFileSync(join(root, "agents.md"), "utf8");
    expect(agentsMd).toContain("<!-- shibumi:ext:auth -->");
    expect(agentsMd).toContain("## Auth extension");
    expect(isInstalled(root, auth)).toBe(true);
  });

  it("numbers the migration past the current high-water mark", () => {
    const root = fixture("full-stack");
    writeFileSync(join(root, "src", "db", "migrations", "0007_custom.sql"), "CREATE TABLE custom (id INTEGER);\n");
    const result = planAdd(root, auth);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.migrationName).toBe("0008_auth.sql");
  });

  it("repeat install does not duplicate anything", async () => {
    const root = fixture("full-stack");
    expect((await cli(root, ["add", "auth", "--yes"])).code).toBe(0);
    const digest = treeDigest(root);
    const again = await cli(root, ["add", "auth", "--yes"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already installed");
    expect(treeDigest(root)).toBe(digest);
    const appTs = readFileSync(join(root, "src", "app.ts"), "utf8");
    expect(appTs.split('app.route("/auth", authRoutes);').length).toBe(2);
  });

  it("dry run writes nothing", async () => {
    const root = fixture("full-stack");
    const digest = treeDigest(root);
    const run = await cli(root, ["add", "auth", "--dry-run"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("Dry run: nothing was written.");
    expect(run.out).toContain("0003_auth.sql");
    expect(treeDigest(root)).toBe(digest);
  });

  it("refuses on a database-less project with the documented message", async () => {
    const root = fixture("web");
    const run = await cli(root, ["add", "auth", "--yes"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("needs the project database and migrations");
    expect(run.err).toContain("bun create shibumi@latest my-app");
  });

  it("always stops on conflicting files, --force included", async () => {
    const root = fixture("full-stack");
    const conflictPath = join(root, "src", "db", "schema-auth.ts");
    writeFileSync(conflictPath, "// user file\n");
    const digest = treeDigest(root);
    const refused = await cli(root, ["add", "auth", "--yes"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Move them aside");
    expect(treeDigest(root)).toBe(digest);

    const forcedRefusal = await cli(root, ["add", "auth", "--yes", "--force"]);
    expect(forcedRefusal.code).toBe(1);
    expect(readFileSync(conflictPath, "utf8")).toBe("// user file\n");
    expect(treeDigest(root)).toBe(digest);
  });

  it("stops when hook anchor text changed, writing nothing", async () => {
    const root = fixture("full-stack");
    const appPath = join(root, "src", "app.ts");
    writeFileSync(appPath, readFileSync(appPath, "utf8").replace('c.json({ ok: true })', 'c.json({ up: true })'));
    const digest = treeDigest(root);
    const run = await cli(root, ["add", "auth", "--yes"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("src/app.ts");
    expect(run.err).toContain("nothing was written");
    expect(treeDigest(root)).toBe(digest);
  });

  it("requires --yes when not a terminal", async () => {
    const root = fixture("full-stack");
    const digest = treeDigest(root);
    const run = await cli(root, ["add", "auth"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("--yes");
    expect(treeDigest(root)).toBe(digest);
  });
});

describe("remove auth", () => {
  it("restores the project byte for byte", async () => {
    const root = fixture("full-stack");
    const digest = treeDigest(root);
    expect((await cli(root, ["add", "auth", "--yes"])).code).toBe(0);
    const removal = await cli(root, ["remove", "auth", "--yes"]);
    expect(removal.code).toBe(0);
    expect(removal.out).toContain("Tables are never dropped");
    expect(treeDigest(root)).toBe(digest);
    expect(isInstalled(root, auth)).toBe(false);
  });

  it("keeps user-modified files unless --force", async () => {
    const root = fixture("full-stack");
    await cli(root, ["add", "auth", "--yes"]);
    const libPath = join(root, "src", "lib", "auth.ts");
    writeFileSync(libPath, `${readFileSync(libPath, "utf8")}\n// user change\n`);
    const refused = await cli(root, ["remove", "auth", "--yes"]);
    expect(refused.code).toBe(1);
    expect(existsSync(libPath)).toBe(true);

    const forced = await cli(root, ["remove", "auth", "--yes", "--force"]);
    expect(forced.code).toBe(0);
    expect(existsSync(libPath)).toBe(false);
  });

  it("removing something not installed is a no-op", async () => {
    const root = fixture("full-stack");
    const run = await cli(root, ["remove", "auth", "--yes"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("not installed");
  });
});

describe("email extension", () => {
  it("adds and removes cleanly on the web template", async () => {
    const root = fixture("web");
    const digest = treeDigest(root);
    expect((await cli(root, ["add", "email", "--yes"])).code).toBe(0);
    const envTs = readFileSync(join(root, "src", "env.ts"), "utf8");
    expect(envTs).toContain("RESEND_API_KEY");
    expect(existsSync(join(root, "src", "lib", "email.ts"))).toBe(true);
    expect(existsSync(join(root, "test", "email.test.ts"))).toBe(true);
    expect(readFileSync(join(root, "agents.md"), "utf8")).toContain("<!-- shibumi:ext:email -->");

    expect((await cli(root, ["remove", "email", "--yes"])).code).toBe(0);
    expect(treeDigest(root)).toBe(digest);
  });

  it("installs on the full-stack template too", async () => {
    const root = fixture("full-stack");
    expect((await cli(root, ["add", "email", "--yes"])).code).toBe(0);
    expect(readFileSync(join(root, "src", "env.ts"), "utf8")).toContain("RESEND_WEBHOOK_SECRET");
  });
});

describe("list and safety", () => {
  it("lists availability and installation state", async () => {
    const root = fixture("full-stack");
    let run = await cli(root, ["list"]);
    expect(run.out).toContain("auth  available");
    await cli(root, ["add", "auth", "--yes"]);
    run = await cli(root, ["list"]);
    expect(run.out).toContain("auth  installed");
    expect(run.out).toContain("email  available");
  });

  it("rejects unknown extensions and unknown flags", async () => {
    const root = fixture("full-stack");
    expect((await cli(root, ["add", "nope", "--yes"])).code).toBe(2);
    expect((await cli(root, ["add", "auth", "--nope"])).code).toBe(2);
  });

  it("refuses writes through symlinked path components", async () => {
    const root = fixture("full-stack");
    const outside = join(work, "outside-target");
    cpSync(join(root, "src", "db"), outside, { recursive: true });
    rmSync(join(root, "src", "db"), { recursive: true, force: true });
    symlinkSync(outside, join(root, "src", "db"));
    const run = await cli(root, ["add", "auth", "--yes"]);
    expect(run.code).toBe(1);
    expect(existsSync(join(outside, "schema-auth.ts"))).toBe(false);
  });

  it("keeps a same-named migration whose content differs, on removal", async () => {
    const root = fixture("full-stack");
    const userMigration = join(root, "src", "db", "migrations", "0003_auth.sql");
    writeFileSync(userMigration, "CREATE TABLE my_own_auth (id INTEGER);\n");
    expect((await cli(root, ["add", "auth", "--yes"])).code).toBe(0);
    expect(existsSync(join(root, "src", "db", "migrations", "0004_auth.sql"))).toBe(true);

    const removal = await cli(root, ["remove", "auth", "--yes"]);
    expect(removal.code).toBe(0);
    expect(removal.out).toContain("content differs");
    expect(readFileSync(userMigration, "utf8")).toBe("CREATE TABLE my_own_auth (id INTEGER);\n");
    expect(existsSync(join(root, "src", "db", "migrations", "0004_auth.sql"))).toBe(false);
  });

  it("refuses bundle paths that escape the project root", () => {
    const root = fixture("full-stack");
    const evil: ExtensionBundle = {
      ...auth,
      files: [{ to: "../evil.ts", content: "boom" }],
    };
    const result = planAdd(root, evil);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unsafe target path");
    expect(existsSync(join(work, "evil.ts"))).toBe(false);

    const absolute = planAdd(root, { ...auth, files: [{ to: "/tmp/evil.ts", content: "boom" }] });
    expect(absolute.ok).toBe(false);
  });

  it("keeps other agents.md sections intact across a remove", async () => {
    const root = fixture("full-stack");
    await cli(root, ["add", "auth", "--yes"]);
    await cli(root, ["add", "email", "--yes"]);
    await cli(root, ["remove", "auth", "--yes"]);
    const agentsMd = readFileSync(join(root, "agents.md"), "utf8");
    expect(agentsMd).not.toContain("shibumi:ext:auth");
    expect(agentsMd).toContain("<!-- shibumi:ext:email -->");
    expect(agentsMd).toContain("## Email extension");
  });
});
