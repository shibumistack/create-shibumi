import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CreateError, createProject, type Runner } from "../src/create";

let work: string;
let templatesDir: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "shibumi-create-"));
  templatesDir = join(work, "templates");
  mkdirSync(join(templatesDir, "static", "src"), { recursive: true });
  writeFileSync(
    join(templatesDir, "static", "package.json"),
    `${JSON.stringify({ name: "placeholder", version: "0.0.0" }, null, 2)}\n`
  );
  writeFileSync(join(templatesDir, "static", "src", "app.ts"), "export {};\n");
  writeFileSync(join(templatesDir, "static", "gitignore"), "node_modules\ndist\n");
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const okRun: Runner = async () => ({ ok: true, code: 0 });

function failOn(command: string): Runner {
  return async (cmd) =>
    cmd.join(" ").startsWith(command) ? { ok: false, code: 1 } : { ok: true, code: 0 };
}

function noTmpLeftovers(): boolean {
  return readdirSync(work).every((entry) => !entry.includes("shibumi-tmp"));
}

function opts(overrides: object = {}) {
  return {
    name: "my-app",
    parentDir: work,
    template: "static" as const,
    git: true,
    install: true,
    templatesDir,
    ...overrides,
  };
}

async function expectFailure(promise: Promise<unknown>, messagePart: string): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(CreateError);
  expect((error as CreateError).message).toContain(messagePart);
  expect(existsSync(join(work, "my-app"))).toBe(false);
  expect(noTmpLeftovers()).toBe(true);
}

describe("createProject", () => {
  it("creates the project atomically and patches the package name", async () => {
    const commands: string[] = [];
    const recorder: Runner = async (cmd) => {
      commands.push(cmd.join(" "));
      return { ok: true, code: 0 };
    };
    const { dest } = await createProject(opts(), recorder);
    expect(dest).toBe(join(work, "my-app"));
    expect(existsSync(join(dest, "src", "app.ts"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8"));
    expect(pkg.name).toBe("my-app");
    expect(noTmpLeftovers()).toBe(true);
    expect(commands).toEqual(["git --version", "git init", "bun install"]);
  });

  it("renames the pack-safe gitignore into place", async () => {
    const { dest } = await createProject(opts(), okRun);
    expect(existsSync(join(dest, "gitignore"))).toBe(false);
    expect(readFileSync(join(dest, ".gitignore"), "utf8")).toContain("node_modules");
  });

  it("rejects invalid names at the mutation boundary", async () => {
    let error: unknown;
    try {
      await createProject(opts({ name: "../escape" }), okRun);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CreateError);
    expect((error as CreateError).message).toContain("Invalid project name");
    expect((error as CreateError).exitCode).toBe(2);
  });

  it("never stages or commits with real git", async () => {
    const { dest } = await createProject(opts({ install: false }));
    expect(existsSync(join(dest, ".git"))).toBe(true);
    const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: dest });
    expect(log.exitCode).not.toBe(0);
    const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: dest });
    expect(status.stdout.toString()).toContain("?? package.json");
  });

  it("refuses an existing destination", async () => {
    mkdirSync(join(work, "my-app"));
    let error: unknown;
    try {
      await createProject(opts(), okRun);
    } catch (err) {
      error = err;
    }
    expect((error as CreateError).message).toContain("Destination already exists");
    expect(readdirSync(join(work, "my-app"))).toEqual([]);
    expect(noTmpLeftovers()).toBe(true);
  });

  it("fails on a missing template", async () => {
    await expectFailure(
      createProject(opts({ template: "web" as const }), okRun),
      'Template "web" is not available'
    );
  });

  it("aborts cleanly when git is missing", async () => {
    await expectFailure(createProject(opts(), failOn("git --version")), "git not found");
  });

  it("aborts cleanly when git init fails", async () => {
    await expectFailure(createProject(opts(), failOn("git init")), "git init failed");
  });

  it("aborts cleanly when install fails", async () => {
    await expectFailure(createProject(opts(), failOn("bun install")), "Dependency install failed");
  });

  it("skips git and install when disabled", async () => {
    const commands: string[] = [];
    const recorder: Runner = async (cmd) => {
      commands.push(cmd.join(" "));
      return { ok: true, code: 0 };
    };
    const { dest } = await createProject(opts({ git: false, install: false }), recorder);
    expect(commands).toEqual([]);
    expect(existsSync(join(dest, ".git"))).toBe(false);
  });

  it("aborts when the destination appears mid-scaffold", async () => {
    let error: unknown;
    try {
      await createProject(opts({ git: false, install: false }), okRun, (step) => {
        if (step === "verify") mkdirSync(join(work, "my-app"));
      });
    } catch (err) {
      error = err;
    }
    expect((error as CreateError).message).toContain("Destination was created while scaffolding");
    expect(readdirSync(join(work, "my-app"))).toEqual([]);
    expect(noTmpLeftovers()).toBe(true);
  });

  async function signalTest(signal: "SIGINT" | "SIGTERM", expectedCode: number): Promise<void> {
    const harness = new URL("./fixtures/hang-create.ts", import.meta.url).pathname;
    const proc = Bun.spawn(["bun", harness, work, templatesDir], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = proc.stdout.getReader();
    let seen = "";
    while (!seen.includes("HANGING")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    proc.kill(signal);
    const code = await proc.exited;
    expect(code).toBe(expectedCode);
    expect(existsSync(join(work, "sig-app"))).toBe(false);
    expect(noTmpLeftovers()).toBe(true);
  }

  it("removes the temp directory on SIGINT and never creates the destination", async () => {
    await signalTest("SIGINT", 130);
  });

  it("removes the temp directory on SIGTERM and never creates the destination", async () => {
    await signalTest("SIGTERM", 143);
  });
});
