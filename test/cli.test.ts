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
      "--yes requires --template (static, web, full-stack).\nRun create-shibumi --help for usage.\n"
    );
  });

  it("rejects unimplemented static options with exit 2", () => {
    const r = runCli(["my-app", "--yes", "--template", "static", "--spa"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not implemented yet");
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
    expect(r.stdout).toContain("cd my-app && bun dev");
  });

  it("fails on an existing destination with exit 1 and leaves it untouched", () => {
    mkdirSync(join(work, "my-app"));
    const r = runCli(["my-app", "--yes", "--template", "static", "--no-install"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Destination already exists");
    expect(existsSync(join(work, "my-app"))).toBe(true);
  });

  it("fails on unavailable templates with exit 1 and no output paths", () => {
    const r = runCli(["my-app", "--yes", "--template", "web", "--no-install", "--no-git"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Template "web" is not available in this build.');
    expect(existsSync(join(work, "my-app"))).toBe(false);
  });
});
