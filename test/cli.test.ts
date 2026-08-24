import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const PKG_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "shibumi-cli-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function runCli(args: string[]) {
  const proc = Bun.spawnSync(["bun", CLI, ...args], {
    cwd: work,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("cli", () => {
  it("prints help with exit 0", () => {
    const r = runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("create-shibumi: scaffold a Shibumi Stack project");
    expect(r.stdout).toContain("--template <id>");
  });

  it("prints the package version with exit 0", () => {
    const r = runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${PKG_VERSION}\n`);
  });

  it("rejects unknown flags with exit 2 and an exact message", () => {
    const r = runCli(["--nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("Unknown flag: --nope\nRun create-shibumi --help for usage.\n");
  });

  it("rejects --yes without a template with exit 2 and an exact message", () => {
    const r = runCli(["my-app", "--yes"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe(
      "--yes requires --template (static, full-stack, blog).\nRun create-shibumi --help for usage.\n"
    );
  });

  it("rejects the dropped static-answer flags with exit 2", () => {
    const r = runCli(["my-app", "--yes", "--template", "static", "--spa"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Unknown flag: --spa");
  });

  it("refuses interactive mode without a TTY with exit 2", () => {
    const r = runCli([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("No interactive terminal.");
  });

  it("scaffolds non-interactively with --yes", () => {
    const r = runCli(["my-app", "--yes", "--template", "static", "--no-install"]);
    expect(r.code).toBe(0);
    const dest = join(work, "my-app");
    expect(existsSync(join(dest, "package.json"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
    expect(existsSync(join(dest, ".git"))).toBe(true);
    const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: dest });
    expect(log.exitCode).not.toBe(0);
    expect(r.stdout).toContain("cd my-app");
    expect(r.stdout).toContain("bun dev");
    expect(r.stdout).toContain("agents.md tells your coding agent the house rules.");
    expect(r.stdout).toContain("Git initialized; nothing committed");
    expect(r.stdout).toContain("Install skipped");
  });

  it("fails on an existing destination with exit 1 and leaves it untouched", () => {
    mkdirSync(join(work, "my-app"));
    const r = runCli(["my-app", "--yes", "--template", "static", "--no-install"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Destination already exists");
    expect(existsSync(join(work, "my-app"))).toBe(true);
  });

  it("refuses the deleted web template with exit 2", () => {
    const r = runCli(["web-app", "--yes", "--template", "web", "--no-install"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown template "web"');
    expect(existsSync(join(work, "web-app"))).toBe(false);
  });

  it("scaffolds the full-stack template with database tooling and the byte-locked ship client", () => {
    const r = runCli(["data-app", "--yes", "--template", "full-stack", "--no-install"]);
    expect(r.code).toBe(0);
    const dest = join(work, "data-app");
    for (const file of [
      "agents.md",
      "compose.yaml",
      "Dockerfile",
      ".dockerignore",
      ".gitignore",
      "drizzle.config.ts",
      "scripts/ship.ts",
      "scripts/db.ts",
      "src/app.ts",
      "src/server.ts",
      "src/env.ts",
      "src/db/schema.ts",
      "src/db/lifecycle.ts",
      "src/db/migrations/0001_notes.sql",
      "test/db.test.ts",
    ]) {
      expect(existsSync(join(dest, file))).toBe(true);
    }
    const vendored = readFileSync(new URL("../src/templates/ship.ts", import.meta.url), "utf8");
    expect(readFileSync(join(dest, "scripts", "ship.ts"), "utf8")).toBe(vendored);
    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
    expect(pkg.name).toBe("data-app");
    expect(pkg.scripts["db:migrate"]).toBe("bun scripts/db.ts migrate");
    expect(pkg.scripts["ship:status"]).toBe("bun scripts/ship.ts --status");
    expect(pkg.scripts.check).toBe("tsc --noEmit");
  });

  it("scaffolds the blog template with agentic and SEO surfaces", () => {
    const r = runCli(["blog-app", "--yes", "--template", "blog", "--no-install"]);
    expect(r.code).toBe(0);
    const dest = join(work, "blog-app");
    for (const file of [
      "agents.md",
      "astro.config.mjs",
      "scripts/ship.ts",
      "src/content.config.ts",
      "src/pages/rss.xml.ts",
      "src/pages/llms.txt.ts",
      "src/pages/robots.txt.ts",
      "src/pages/posts/[id].md.ts",
      "src/content/blog/own-your-source.md",
      "public/og-default.png",
      ".gitignore",
    ]) {
      expect(existsSync(join(dest, file))).toBe(true);
    }
    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
    expect(pkg.scripts["ship:setup"]).toContain("--static --output-dir dist --build-script build");
  });
});
