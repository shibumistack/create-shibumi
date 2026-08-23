import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

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
