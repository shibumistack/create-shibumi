import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { mkdtempSync, readFileSync } from "fs";
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
describe("ship:webhook", () => {
  const SHIP = join(ROOT, "src", "templates", "ship.ts");

  function runShip(args: string[]) {
    const proc = Bun.spawnSync(["bun", SHIP, ...args], {
      // A directory with no shibumi-server.json: every case below stops at
      // argument parsing or the missing-setup guard, so nothing reaches the
      // network, git, or SSH.
      cwd: mkdtempSync(join(tmpdir(), "shibumi-ship-")),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
  }

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

  it("drops the trigger flag with its question", () => {
    expect(runShip(["--setup", "--trigger", "github-push"]).output).toContain(
      "unknown ship option: --trigger"
    );
    expect(vendored).not.toContain("How do you want to deploy?");
  });

  it("keeps webhook creation out of the default setup path", () => {
    const setupBody = /\nasync function setup\(([\s\S]*?)\n}\n/.exec(vendored)?.[1] ?? "";
    expect(setupBody).not.toContain("ensureWebhook");
    expect(setupBody).not.toContain("disableWebhook");
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
