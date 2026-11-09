import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2EProcesses } from "../scripts/e2e-process";
import { commitRestoreIfChanged } from "../scripts/e2e-target";

const linuxTest = process.platform === "linux" ? test : test.skip;

async function waitForStopped(pid: number): Promise<boolean> {
  // SIGKILL is asynchronous. A reaped or zombie process cannot keep working.
  for (let i = 0; i < 50; i++) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      if (stat.split(") ")[1]?.startsWith("Z")) return true;
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return true;
      throw error;
    }
    await Bun.sleep(20);
  }
  return false;
}

linuxTest("termination check rejects a still-running process", async () => {
  expect(await waitForStopped(process.pid)).toBe(false);
});

linuxTest("Bun detached child and grandchild share a killable process group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-group-"));
  const processes = new E2EProcesses();
  const grandchild = join(dir, "grandchild.pid");
  const script = `const p = Bun.spawn(["bun", "-e", "await Bun.sleep(60000)"], {stdout:"ignore",stderr:"ignore"}); await Bun.write(${JSON.stringify(grandchild)}, String(p.pid)); await p.exited;`;
  try {
    const child = processes.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "ignore" });
    let pid = 0;
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(grandchild, "utf8")); break; } catch { await Bun.sleep(20); }
    }
    expect(pid).toBeGreaterThan(0);
    const pgid = async (p: number) => {
      const ps = Bun.spawn(["ps", "-o", "pgid=", "-p", String(p)], { stdout: "pipe" });
      const [code, out] = await Promise.all([ps.exited, new Response(ps.stdout).text()]);
      expect(code).toBe(0);
      return out.trim();
    };
    expect(await pgid(child.pid)).toBe(String(child.pid));
    expect(await pgid(pid)).toBe(String(child.pid));
    await processes.stop(child);
    expect(await waitForStopped(pid)).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) linuxTest(`${signal} stops nested work before owned cleanup can run`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-cancel-"));
  const pidFile = join(dir, "grandchild.pid");
  const restored = join(dir, "restored");
  const helper = join(import.meta.dir, "../scripts/e2e-process.ts");
  const worker = `import { E2EProcesses } from ${JSON.stringify(helper)};
    const p = new E2EProcesses();
    try { await p.run(["bun", "-e", ${JSON.stringify(`const c = Bun.spawn(["bun", "-e", "await Bun.sleep(60000)"], {stdout:"ignore"}); await Bun.write(${JSON.stringify(pidFile)}, String(c.pid)); await c.exited;`)}], { stdout:"pipe", stderr:"pipe" }); }
    catch {
      p.cleanup();
      await p.run(["bun", "-e", ${JSON.stringify(`await Bun.write(${JSON.stringify(restored)}, "restored")`)}], {stdout:"pipe", stderr:"pipe"});
      p.resumeWork();
      try { p.check(); process.exitCode = 1; } catch { process.exitCode = p.exitCode; }
    }`;
  const runner = Bun.spawn(["bun", "-e", worker], { stdout: "pipe", stderr: "pipe" });
  try {
    let pid = 0;
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(pidFile, "utf8")); break; } catch { await Bun.sleep(20); }
    }
    expect(pid).toBeGreaterThan(0);
    runner.kill(signal);
    expect(await runner.exited).toBe(signal === "SIGINT" ? 130 : 143);
    expect(await readFile(restored, "utf8")).toBe("restored");
    expect(await waitForStopped(pid)).toBe(true);
  } finally { if (!runner.killed) runner.kill("SIGKILL"); await rm(dir, { recursive: true, force: true }); }
});

linuxTest("timeout stops the whole subprocess group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-timeout-"));
  const pidFile = join(dir, "grandchild.pid");
  const processes = new E2EProcesses();
  const script = `const c = Bun.spawn(["bun", "-e", "await Bun.sleep(60000)"], {stdout:"ignore",stderr:"ignore"}); await Bun.write(${JSON.stringify(pidFile)}, String(c.pid)); await c.exited;`;
  try {
    await expect(processes.run(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" }, 1500)).rejects.toThrow("timed out");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(await waitForStopped(pid)).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("early replacement failure restores archive without an empty commit and still deploys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-restore-"));
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code) throw new Error(`git ${args.join(" ")} failed`);
    return out;
  };
  try {
    await git("init", "-q");
    await git("config", "user.email", "e2e@example.com");
    await git("config", "user.name", "E2E");
    await writeFile(join(dir, "fixture"), "original\n");
    await git("add", "-A");
    await git("commit", "-qm", "original");
    const head = (await git("rev-parse", "HEAD")).trim();
    await writeFile(join(dir, "fixture"), "replacement that failed before commit\n");
    // Equivalent to extracting original.tar when HEAD is still the snapshot.
    await git("restore", "fixture");
    let commits = 0;
    await commitRestoreIfChanged(args => git(...args.slice(1)), async () => { commits++; await git("commit", "-am", "restore"); });
    // The matrix proceeds to Ship and counter checks even without a new commit.
    const deployed = (await git("rev-parse", "HEAD")).trim();
    expect(commits).toBe(0);
    expect(deployed).toBe(head);
    expect(await readFile(join(dir, "fixture"), "utf8")).toBe("original\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
