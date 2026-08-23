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
    const a = ok(["my-app", "--template", "web", "--no-git", "--no-install"]);
    expect(a.name).toBe("my-app");
    expect(a.template).toBe("web");
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
    expect(err(["--template", "blog"])).toContain('Unknown template "blog"');
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

  it("restricts static-only flags to the static template", () => {
    expect(err(["x", "--template", "web", "--spa"])).toBe(
      "--spa only applies to the static template."
    );
    expect(err(["x", "--template", "web", "--output-dir", "dist"])).toBe(
      "--output-dir only applies to the static template."
    );
    const a = ok(["x", "--template", "static", "--output-dir", "dist", "--spa"]);
    expect(a.outputDir).toBe("dist");
    expect(a.spa).toBe(true);
  });

  it("validates output directories", () => {
    expect(err(["x", "--template", "static", "--output-dir", "/abs"])).toContain(
      "must be a relative path"
    );
    expect(err(["x", "--template", "static", "--output-dir", "../up"])).toContain(
      'must not contain ".."'
    );
    expect(ok(["x", "--template", "static", "--output-dir", "build/out"]).outputDir).toBe(
      "build/out"
    );
  });

  it("validates build script names", () => {
    expect(err(["x", "--template", "static", "--build-script", "rm -rf /"])).toContain(
      "must be a package script name"
    );
    expect(ok(["x", "--template", "static", "--build-script", "build:site"]).buildScript).toBe(
      "build:site"
    );
  });
});
