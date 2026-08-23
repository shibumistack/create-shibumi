import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");

describe("static build", () => {
  it("builds dist/ from content", () => {
    // Clean
    if (existsSync(DIST)) rmSync(DIST, { recursive: true });

    // Build
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: ROOT });
    expect(build.exitCode).toBe(0);

    // Check output
    expect(existsSync(join(DIST, "index.html"))).toBe(true);
    expect(existsSync(join(DIST, "hello.html"))).toBe(true);
    expect(existsSync(join(DIST, "style.css"))).toBe(true);

    const index = readFileSync(join(DIST, "index.html"), "utf-8");
    expect(index).toContain("Hello, Shibumi");
    expect(index).toContain("/hello.html");

    const post = readFileSync(join(DIST, "hello.html"), "utf-8");
    expect(post).toContain("Hello, Shibumi");
    expect(post).toContain("Welcome to your static site");

    // Clean up
    rmSync(DIST, { recursive: true });
  });
});
