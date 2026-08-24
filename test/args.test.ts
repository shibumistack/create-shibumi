import { describe, expect, it } from "bun:test";
import { parseArgs } from "../src/args";

function ok(argv: string[]) {
  const r = parseArgs(argv);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.args;
}

function err(argv: string[]): string {
  const r = parseArgs(argv);
  if (r.ok) throw new Error(`expected error for: ${argv.join(" ")}`);
  return r.error;
}

describe("parseArgs", () => {
  it("parses defaults", () => {
    const a = ok([]);
    expect(a.git).toBe(true);
    expect(a.install).toBe(true);
    expect(a.yes).toBe(false);
    expect(a.name).toBeUndefined();
  });

  it("parses name, template, and opt-outs", () => {
    const a = ok(["my-app", "--template", "blog", "--no-git", "--no-install"]);
    expect(a.name).toBe("my-app");
    expect(a.template).toBe("blog");
    expect(a.git).toBe(false);
    expect(a.install).toBe(false);
  });

  it("supports --flag=value form", () => {
    const a = ok(["x", "--template=full-stack"]);
    expect(a.template).toBe("full-stack");
  });

  it("parses help and version without further validation", () => {
    expect(ok(["--help"]).help).toBe(true);
    expect(ok(["-h"]).help).toBe(true);
    expect(ok(["--version"]).version).toBe(true);
    expect(ok(["--version", "--yes"]).version).toBe(true);
  });

  it("rejects unknown flags", () => {
    expect(err(["--foo"])).toBe("Unknown flag: --foo");
    expect(err(["--force"])).toBe("Unknown flag: --force");
  });

  it("rejects a boolean flag with a value", () => {
    expect(err(["--yes=true"])).toBe("--yes does not take a value.");
  });

  it("rejects a value flag without a value", () => {
    expect(err(["--template"])).toBe("--template requires a value.");
    expect(err(["--template", "--yes"])).toBe("--template requires a value.");
  });

  it("rejects unknown templates", () => {
    expect(err(["--template", "docs"])).toContain('Unknown template "docs"');
  });

  it("rejects the deleted web template", () => {
    expect(err(["--template", "web"])).toBe(
      'Unknown template "web". Available: static, full-stack, blog.'
    );
  });

  it("rejects extra positionals", () => {
    expect(err(["a", "b"])).toContain('Unexpected argument "b"');
  });

  it("validates project names", () => {
    expect(err(["My App"])).toContain("Invalid project name");
    expect(err(["-app"])).toBe("Unknown flag: -app");
    expect(err([".hidden"])).toContain("Invalid project name");
    expect(err(["UPPER"])).toContain("Invalid project name");
    expect(ok(["a1.b_c-d"]).name).toBe("a1.b_c-d");
  });

  it("requires name and template with --yes", () => {
    expect(err(["--yes"])).toBe("--yes requires a project name.");
    expect(err(["my-app", "--yes"])).toContain("--yes requires --template");
    expect(ok(["my-app", "--yes", "--template", "static"]).yes).toBe(true);
  });

  it("enforces the Bun version floor with a clear message", () => {
    const { bunVersionProblem } = require("../src/args") as typeof import("../src/args");
    expect(bunVersionProblem("1.4.0")).toBeNull();
    expect(bunVersionProblem("1.10.2")).toBeNull();
    expect(bunVersionProblem("2.0.0")).toBeNull();
    expect(bunVersionProblem("1.2.0")).toContain("needs Bun 1.4.0 or newer");
    expect(bunVersionProblem("1.3.9")).toContain("bun upgrade");
    expect(bunVersionProblem("1.4.0-canary.1")).toBeNull();
  });

  it("rejects the dropped static-answer flags as unknown", () => {
    // ship:setup owns output dir, build script, and SPA choices now
    // (owner decision, ws7); the create surface must not half-support them.
    expect(err(["x", "--template", "static", "--spa"])).toBe("Unknown flag: --spa");
    expect(err(["x", "--template", "static", "--output-dir", "dist"])).toBe(
      "Unknown flag: --output-dir"
    );
    expect(err(["x", "--template", "static", "--build-script", "build"])).toBe(
      "Unknown flag: --build-script"
    );
  });
});
