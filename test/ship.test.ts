import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TEMPLATES } from "../src/args";

const ROOT = join(import.meta.dir, "..");
const lock = JSON.parse(readFileSync(join(ROOT, "scripts", "ship.lock.json"), "utf8")) as {
  url: string;
  sha256: string;
};
const vendored = readFileSync(join(ROOT, "src", "templates", "ship.ts"), "utf8");

describe("vendored ship client", () => {
  it("is byte-identical to the locked immutable snapshot", () => {
    const sha256 = createHash("sha256").update(vendored).digest("hex");
    expect(sha256).toBe(lock.sha256);
  });

  it("locks an immutable versioned URL", () => {
    expect(lock.url).toMatch(/^https:\/\/shibumistack\.dev\/ship\/v\d+\.ts$/);
  });

  it("self-references the same immutable version it was locked to", () => {
    const m = /const CURRENT_SOURCE = "(https:\/\/shibumistack\.dev\/ship\/v\d+\.ts)";/.exec(
      vendored
    );
    expect(m?.[1]).toBe(lock.url);
  });
});

// The client is a vendored artifact with its own compiler settings, so it is
// exercised through its entry point rather than imported (an import would pull
// it into this package's stricter tsc program).
const SHIP = join(ROOT, "src", "templates", "ship.ts");

function runShip(args: string[], cwd?: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bun", SHIP, ...args], {
    // Without a cwd, a directory holding no shibumi-server.json: those cases
    // stop at argument parsing or the missing-setup guard, so nothing reaches
    // the network, git, or SSH.
    cwd: cwd ?? mkdtempSync(join(tmpdir(), "shibumi-ship-")),
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

// Exported pure helpers, evaluated in a child process for the same reason.
function shipValue(expression: string): unknown {
  const proc = Bun.spawnSync([
    "bun", "-e",
    `import * as ship from ${JSON.stringify(SHIP)};\nprocess.stdout.write(JSON.stringify(${expression}));`,
  ], { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return JSON.parse(proc.stdout.toString());
}

describe("ship:webhook", () => {
  it("runs as its own action and stops without setup", () => {
    const r = runShip(["--webhook"]);
    expect(r.code).toBe(1);
    expect(r.output).toContain("Shibumi setup is missing.");
    expect(r.output).toContain("Next: run bun ship:setup.");
  });

  it("reverses with --off, which only exists on the webhook action", () => {
    expect(runShip(["--webhook", "--off"]).output).toContain("Shibumi setup is missing.");
    expect(runShip(["--off"]).output).toContain("--off requires --webhook");
    expect(runShip(["--webhook", "--setup"]).output).toContain("choose only one ship action");
  });

  it("drops the trigger flag", () => {
    // The question it used to open, and the webhook it used to create, are
    // covered behaviourally in test/setup.plan.test.ts: a whole setup run
    // asks neither and never calls GitHub about hooks.
    expect(runShip(["--setup", "--trigger", "github-push"]).output).toContain(
      "unknown ship option: --trigger"
    );
  });

  it("is wired into every template that ships", () => {
    for (const id of TEMPLATES) {
      const pkg = JSON.parse(
        readFileSync(join(ROOT, "src", "templates", id, "package.json"), "utf8")
      ) as { scripts: Record<string, string> };
      if (!pkg.scripts.ship) continue;
      expect(pkg.scripts["ship:webhook"]).toBe("bun scripts/ship.ts --webhook");
    }
  });
});

describe("setup plan", () => {
  it("lists repository creation, connection, registration, and the trigger", () => {
    expect(shipValue(`ship.setupPlanLines({
      target: "alpha",
      domain: "quiet-bamboo.dev",
      branch: "main",
      newRepository: "bitbonsai/quiet-bamboo",
      visibility: "private",
      commit: true,
    })`)).toEqual([
      "Create private repo bitbonsai/quiet-bamboo, push main",
      "Connect to alpha, save target for this project",
      "Install or upgrade shibumi-server (sudo password once)",
      "Register quiet-bamboo.dev",
      "Commit and push deployment files",
      "Deploys run on: bun ship",
    ]);
  });

  it("drops the repository and commit lines when neither is needed", () => {
    expect(shipValue(`ship.setupPlanLines({
      target: "alpha",
      domain: "quiet-bamboo.dev",
      branch: "main",
      visibility: "private",
      commit: false,
    })`)).toEqual([
      "Connect to alpha, save target for this project",
      "Install or upgrade shibumi-server (sudo password once)",
      "Register quiet-bamboo.dev",
      "Deploys run on: bun ship",
    ]);
  });

  it("says public only when --public asked for it", () => {
    expect(shipValue(`ship.setupPlanLines({
      target: "alpha", domain: "a.dev", branch: "main",
      newRepository: "me/a", visibility: "public", commit: false,
    })[0]`)).toBe("Create public repo me/a, push main");
  });

  it("derives the repository name from the package or the directory", () => {
    expect(shipValue(`ship.repositoryNameFromProject("@scope/Quiet Bamboo", "ignored")`)).toBe("quiet-bamboo");
    expect(shipValue(`ship.repositoryNameFromProject(undefined, "Quiet Bamboo!")`)).toBe("quiet-bamboo");
    expect(shipValue(`ship.repositoryNameFromProject("", "...")`)).toBe("app");
  });

  it("keeps --interactive and --public attached to setup", () => {
    expect(runShip(["--interactive"]).output).toContain("--interactive requires --setup");
    expect(runShip(["--public"]).output).toContain("--public requires --setup");
    expect(runShip(["--setup", "--interactive", "--yes"]).output).toContain(
      "--interactive and --yes are mutually exclusive"
    );
  });
});

describe("setup without a GitHub origin", () => {
  function project(): string {
    const dir = mkdtempSync(join(tmpdir(), "shibumi-origin-"));
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "quiet-bamboo.dev" })}\n`);
    writeFileSync(join(dir, "compose.yaml"), "services:\n  app:\n    build: .\n");
    const git = (...args: string[]) =>
      Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=Test", ...args], { cwd: dir });
    git("init", "-q", ".");
    git("add", "-A");
    git("commit", "-q", "-m", "Initial commit");
    return dir;
  }

  it("stops with the agent handoff instead of creating a repository", () => {
    const dir = project();
    const r = runShip(["--setup", "--server", "alpha"], dir, {
      XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "shibumi-xdg-")),
    });
    expect(r.code).toBe(1);
    expect(r.output).toContain("This project has no GitHub origin.");
    expect(r.output).toContain("Agent: ask user whether to create a repository for quiet-bamboo.dev");
    const remotes = Bun.spawnSync(["git", "remote"], { cwd: dir }).stdout.toString().trim();
    expect(remotes).toBe("");
  });

  it("leaves an uncommitted Compose file for the user to review", () => {
    const dir = mkdtempSync(join(tmpdir(), "shibumi-origin-"));
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "quiet-bamboo.dev" })}\n`);
    writeFileSync(join(dir, "compose.yaml"), "services:\n  app:\n    build: .\n");
    Bun.spawnSync(["git", "init", "-q", "."], { cwd: dir });
    const r = runShip(["--setup"], dir, {
      XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "shibumi-xdg-")),
    });
    expect(r.output).toContain("Found uncommitted compose.yaml");
    expect(Bun.spawnSync(["git", "log", "--oneline"], { cwd: dir }).exitCode).not.toBe(0);
  });
});
