import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inheritedSshAdapter, resolveSshInvocation, startSshAdapter, type SshAdapter } from "../scripts/e2e-ssh";

const target = "user@e2e-host";
const socket = "/tmp/e2e-adapter/control-%C";

// Stands in for ssh: records argv and the exact stdin bytes, then exits with
// the configured code. Both live outside the adapter directory so they survive
// the owner's cleanup.
const fakeSsh = `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const log = process.env.FAKE_SSH_LOG;
await appendFile(log, JSON.stringify(Bun.argv.slice(2)) + "\\n");
const bytes = new Uint8Array(await new Response(Bun.stdin.stream()).arrayBuffer());
await Bun.write(log + ".stdin", bytes);
process.exit(Number(process.env.FAKE_SSH_EXIT ?? "0"));
`;

async function recorded(log: string): Promise<string[][]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.trim() ? text.trim().split("\n").map(line => JSON.parse(line) as string[]) : [];
}

async function shim(adapter: SshAdapter, argv: string[], env: Record<string, string>, stdin: Uint8Array | "ignore" = "ignore") {
  const child = Bun.spawn([join(adapter.dir, "ssh"), ...argv], {
    env: { ...adapter.env, ...env }, stdin, stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

test("adapter normalizes only the configured destination and keeps every other boundary", () => {
  const config = { target, socket };
  const remote = ["env", "SHIBUMI_SKIP_UPDATE_CHECK=1", "shis", "status", "app", "--json", "--commit", "abc123"];
  const ship = resolveSshInvocation(config, ["-o", "StrictHostKeyChecking=no", "-o", "ControlMaster=no", "-o", "ControlPath=/tmp/ship-control", "-S", "/tmp/ship/control", "-C", "-t", "--", target, ...remote]);
  if (ship.action !== "exec") throw new Error("expected exec");
  expect(ship.argv.slice(-(remote.length + 2))).toEqual(["--", target, ...remote]);
  expect(ship.argv).toContain("-C");
  expect(ship.argv).toContain("-t");
  expect(ship.argv).not.toContain("/tmp/ship/control");
  expect(ship.argv).not.toContain("ControlPath=/tmp/ship-control");
  // Forced values come first, replace caller control options and stay unique.
  expect(ship.argv.slice(0, 4)).toEqual(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"]);
  for (const value of ["ControlMaster=auto", "ControlPersist=600", "StrictHostKeyChecking=yes", "BatchMode=yes"]) {
    expect(ship.argv.filter(arg => arg === value)).toHaveLength(1);
  }
  expect(ship.argv[ship.argv.indexOf("-S") + 1]).toBe(socket);

  // Caller-supplied control options in every accepted spelling are dropped.
  for (const args of [
    ["-o", "controlpath=/tmp/a", "-S", "/tmp/b", "--", target],
    ["-oControlPath=/tmp/a", "-S/tmp/b", "--", target],
    ["-o", "ControlPersist=60", "-o", "ControlMaster=auto", "-S", "/tmp/b", target],
  ]) {
    const result = resolveSshInvocation(config, args);
    if (result.action !== "exec") throw new Error("expected exec");
    expect(result.argv).not.toContain("/tmp/a");
    expect(result.argv).not.toContain("/tmp/b");
    expect(result.argv.filter(arg => /^control(path|master|persist)=/i.test(arg))).toHaveLength(2);
  }

  // Other option boundaries and their values survive untouched.
  const other = resolveSshInvocation(config, ["-p", "2222", "-l", "deploy", "-o", "UserKnownHostsFile=/tmp/kh", "-i", "/tmp/key", "--", target, "cat", "-n"]);
  if (other.action !== "exec") throw new Error("expected exec");
  expect(other.argv.slice(0, 6)).toEqual(["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"]);
  expect(other.argv.slice(16, 25)).toEqual(["-p", "2222", "-l", "deploy", "-o", "UserKnownHostsFile=/tmp/kh", "-i", "/tmp/key", "--"]);
  expect(other.argv.slice(-3)).toEqual([target, "cat", "-n"]);

  // A child close of the shared master is a no-op, in separated and attached form.
  expect(resolveSshInvocation(config, ["-S", socket, "-O", "exit", "--", target])).toEqual({ action: "skip", reason: "control-exit" });
  expect(resolveSshInvocation(config, ["-Oexit", target])).toEqual({ action: "skip", reason: "control-exit" });
  // Unrelated hosts, and calls without a destination, pass through verbatim,
  // including their own -S and -O options.
  for (const args of [
    ["-S", "/tmp/git-control", "-o", "ControlMaster=auto", "--", "git@github.com", "git-upload-pack", "example/shibumi-e2e.git"],
    ["-o", "BatchMode=yes", "-O", "exit", "--", "git@github.com"],
    ["-V"],
    ["-G", "--", "github.com"],
  ]) {
    const result = resolveSshInvocation(config, args);
    if (result.action !== "exec") throw new Error("expected exec");
    expect(result.argv).toEqual(args);
  }
});

test("shim keeps binary stdin, suppresses child close and cleans up once as owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "e2e-ssh-check-"));
  const log = join(root, "fake.log");
  const real = join(root, "fake-ssh");
  const previous = new Map<string, string | undefined>();
  const remember = (key: string) => { if (!previous.has(key)) previous.set(key, process.env[key]); };
  let adapter: SshAdapter | undefined;
  try {
    await writeFile(real, fakeSsh, { mode: 0o700 });
    await chmod(real, 0o700);
    adapter = await startSshAdapter(target, { real });
    const env = { FAKE_SSH_LOG: log };

    expect((await stat(adapter.dir)).mode & 0o777).toBe(0o700);
    expect(adapter.socket).toBe(join(adapter.dir, "control-%C"));
    expect(adapter.socket.length).toBeLessThan(100);
    expect(adapter.env.PATH!.startsWith(adapter.dir + ":")).toBe(true);
    expect((await stat(join(adapter.dir, "ssh"))).mode & 0o777).toBe(0o700);

    // Binary stdin arrives byte-for-byte and caller control options are normalized.
    const stdin = new Uint8Array([0x00, 0x01, 0xff, 0x0d, 0x0a, 0x50, 0x4b]);
    const managed = await shim(adapter, ["-o", "ControlMaster=auto", "-S", "/tmp/caller-control", "-C", "--", target, "ti", "push", "app"], env, stdin);
    expect(managed.code).toBe(0);
    const [managedArgs] = await recorded(log);
    if (!managedArgs) throw new Error("managed call was not recorded");
    expect(managedArgs.slice(-5)).toEqual(["--", target, "ti", "push", "app"]);
    expect(managedArgs).toContain("-C");
    expect(managedArgs).not.toContain("/tmp/caller-control");
    expect(managedArgs.filter(arg => arg === "ControlMaster=auto")).toHaveLength(1);
    expect(managedArgs[managedArgs.indexOf("-S") + 1]).toBe(adapter.socket);
    expect(new Uint8Array(await readFile(`${log}.stdin`))).toEqual(stdin);

    // An unrelated host keeps the caller's argv exactly, including -S.
    const passthrough = ["-S", "/tmp/git-control", "-o", "ControlMaster=auto", "--", "git@github.com", "git-upload-pack", "example/repo.git"];
    expect((await shim(adapter, passthrough, env)).code).toBe(0);
    expect(await recorded(log)).toEqual([managedArgs, passthrough]);

    // A child -O exit is a no-op: the fake ssh is never invoked again.
    expect((await shim(adapter, ["-S", adapter.socket, "-O", "exit", "--", target], env)).code).toBe(0);
    expect((await recorded(log)).length).toBe(2);

    // A nested runner inherits validation but never owns the master.
    for (const [key, value] of Object.entries(adapter.env)) { remember(key); process.env[key] = value; }
    const inherited = await inheritedSshAdapter(target);
    expect(inherited?.owner).toBe(false);
    expect(inherited!.socket).toBe(adapter.socket);
    await inherited!.close();
    expect((await recorded(log)).length).toBe(2);
    expect((await stat(adapter.dir)).isDirectory()).toBe(true);
    await expect(inheritedSshAdapter("user@other-host")).rejects.toThrow("different target");

    // The owner closes with the real ssh exactly once, then removes the run dir.
    remember("FAKE_SSH_LOG");
    process.env.FAKE_SSH_LOG = log;
    await adapter.close();
    await adapter.close();
    expect(await recorded(log)).toEqual([managedArgs, passthrough, ["-S", adapter.socket, "-O", "exit", "--", target]]);
    await expect(stat(adapter.dir)).rejects.toThrow();
  } finally {
    await adapter?.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("an incomplete or foreign adapter environment is refused instead of duplicated", async () => {
  const previous = new Map<string, string | undefined>();
  const remember = (key: string) => { if (!previous.has(key)) previous.set(key, process.env[key]); };
  try {
    remember("SHIBUMI_E2E_SSH_DIR");
    process.env.SHIBUMI_E2E_SSH_DIR = "/tmp/whatever";
    await expect(inheritedSshAdapter(target)).rejects.toThrow("incomplete");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
