import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectBuildOutput, shipScripts } from "../src/adopt";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const VENDORED = readFileSync(new URL("../src/templates/ship.ts", import.meta.url), "utf8");

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "shibumi-adopt-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function adopt(args: string[] = []) {
  const proc = Bun.spawnSync(["bun", CLI, ".", "--yes", ...args], {
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

function writePackage(pkg: object): void {
  writeFileSync(join(work, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function readPackage(): { scripts: Record<string, string>; devDependencies: Record<string, string> } {
  return JSON.parse(readFileSync(join(work, "package.json"), "utf8"));
}

describe("detectBuildOutput", () => {
  it("reads the framework before the directory", () => {
    // Astro and Eleventy both depend on Vite; a bare Vite match must lose.
    expect(detectBuildOutput({ dependencies: { astro: "7.2.4", vite: "6" }, files: [] })).toEqual({
      framework: "Astro",
      outputDir: "dist",
      source: "framework",
    });
    expect(detectBuildOutput({ dependencies: { "@11ty/eleventy": "3" }, files: [] })?.outputDir).toBe("_site");
    expect(detectBuildOutput({ dependencies: { next: "15" }, files: [] })?.outputDir).toBe("out");
    expect(detectBuildOutput({ dependencies: { vite: "6" }, files: [] })?.outputDir).toBe("dist");
  });

  it("recognizes a config file without the dependency", () => {
    expect(detectBuildOutput({ files: ["astro.config.mjs"] })?.outputDir).toBe("dist");
    expect(detectBuildOutput({ files: ["eleventy.config.js"] })?.outputDir).toBe("_site");
    expect(detectBuildOutput({ files: ["next.config.ts"] })?.outputDir).toBe("out");
  });

  it("falls back to a build directory on disk, then public/", () => {
    expect(detectBuildOutput({ files: ["_site", "Gemfile"] })).toEqual({
      framework: "existing build output",
      outputDir: "_site",
      source: "directory",
    });
    expect(detectBuildOutput({ files: ["public", "index.php"] })?.outputDir).toBe("public");
    expect(detectBuildOutput({ files: ["index.html"] })).toBeUndefined();
  });
});

describe("shipScripts", () => {
  it("pins the static answers into ship:setup", () => {
    expect(shipScripts({ outputDir: "dist", buildScript: "build", spa: false })["ship:setup"]).toBe(
      "bun scripts/ship.ts --setup --static --output-dir dist --build-script build --no-spa"
    );
    expect(shipScripts({ outputDir: "public", spa: true })["ship:setup"]).toBe(
      "bun scripts/ship.ts --setup --static --output-dir public --spa"
    );
  });
});

describe("bun create shibumi .", () => {
  it("vendors the client and generates deployment files without scaffolding", () => {
    writePackage({ name: "quiet-bamboo", scripts: { build: "astro build" }, dependencies: { astro: "7.2.4" } });
    const r = adopt();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Existing project found (Astro detected)");
    expect(readFileSync(join(work, "scripts", "ship.ts"), "utf8")).toBe(VENDORED);
    expect(readFileSync(join(work, "compose.yaml"), "utf8")).toContain(
      `dev.shibumistack.static.output: "dist"`
    );
    expect(readFileSync(join(work, "Dockerfile"), "utf8")).toContain("busybox");
    expect(readFileSync(join(work, ".dockerignore"), "utf8")).toBe("*\n!dist\n");
    const pkg = readPackage();
    expect(pkg.scripts["ship:setup"]).toBe(
      "bun scripts/ship.ts --setup --static --output-dir dist --build-script build --no-spa"
    );
    expect(pkg.scripts["ship:webhook"]).toBe("bun scripts/ship.ts --webhook");
    expect(pkg.scripts.build).toBe("astro build");
    // The client imports @clack/prompts, so an adopted project must declare it.
    expect(pkg.devDependencies["@clack/prompts"]).toMatch(/^\d+\.\d+\.\d+$/);
    // Adopting is not scaffolding: no git init, no install, no template.
    expect(existsSync(join(work, ".git"))).toBe(false);
    expect(existsSync(join(work, "node_modules"))).toBe(false);
    expect(existsSync(join(work, "agents.md"))).toBe(false);
  });

  it("never overwrites a file the project already owns", () => {
    writePackage({ name: "mine", scripts: { build: "vite build", ship: "echo mine" }, devDependencies: { vite: "6" } });
    writeFileSync(join(work, "Dockerfile"), "# mine\n");
    mkdirSync(join(work, "scripts"), { recursive: true });
    writeFileSync(join(work, "scripts", "ship.ts"), "// mine\n");
    const r = adopt();
    expect(r.code).toBe(0);
    expect(readFileSync(join(work, "Dockerfile"), "utf8")).toBe("# mine\n");
    expect(readFileSync(join(work, "scripts", "ship.ts"), "utf8")).toBe("// mine\n");
    expect(readPackage().scripts.ship).toBe("echo mine");
    expect(r.stdout).toContain("Left untouched");
  });

  it("serves unknown paths from index.html with --spa", () => {
    writePackage({ name: "app", scripts: { build: "vite build" }, devDependencies: { vite: "6" } });
    expect(adopt(["--spa"]).code).toBe(0);
    expect(readPackage().scripts["ship:setup"]).toContain("--spa");
    expect(readFileSync(join(work, "Dockerfile"), "utf8")).toContain("static-server.ts");
    expect(existsSync(join(work, "scripts", "static-server.ts"))).toBe(true);
  });

  it("works without a package.json", () => {
    mkdirSync(join(work, "public"));
    writeFileSync(join(work, "public", "index.html"), "<!doctype html>\n");
    writeFileSync(join(work, "Gemfile"), "gem 'jekyll'\n");
    expect(adopt().code).toBe(0);
    const pkg = readPackage() as { name?: string; scripts: Record<string, string> };
    expect(pkg.scripts["ship:setup"]).toBe(
      "bun scripts/ship.ts --setup --static --output-dir public --no-spa"
    );
    // The created name feeds ship's domain inference, so it tracks the
    // directory: a project in kunstfy.com/ infers that domain, my-blog/ asks.
    expect(pkg.name).toBe(work.split("/").pop()!.toLowerCase());
    expect(readFileSync(join(work, ".dockerignore"), "utf8")).toBe("*\n!public\n");
  });

  it("sends a server app to ship:setup instead of generating a static image", () => {
    writePackage({ name: "api", scripts: { start: "bun dist/server.js", build: "bun build src/server.ts --outdir dist" } });
    mkdirSync(join(work, "dist"));
    const r = adopt();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("This looks like a server app");
    expect(existsSync(join(work, "compose.yaml"))).toBe(false);
    expect(existsSync(join(work, "scripts", "ship.ts"))).toBe(false);
  });

  it("refuses an empty directory with exit 2", () => {
    const r = adopt();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Nothing to adopt: this directory is empty.");
  });

  it("stops with exit 1 when nothing is detectable non-interactively", () => {
    writeFileSync(join(work, "index.html"), "<!doctype html>\n");
    const r = adopt();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Could not detect the built site directory.");
    expect(existsSync(join(work, "compose.yaml"))).toBe(false);
  });

  it("refuses a template with an existing project", () => {
    writePackage({ name: "app" });
    const r = adopt(["--template", "static"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--template does not apply to an existing project");
  });
});
