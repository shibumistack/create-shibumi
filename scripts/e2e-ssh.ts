// Run-owned SSH transport for the opt-in E2E runners. Never imported by
// ordinary tests or shipped code.
//
// Every E2E child (Ship, the nested runner, git over SSH) resolves `ssh` from
// PATH. The run owner creates one private directory, pins the real ssh
// executable, writes an `ssh` shim there and prepends that directory to the
// child PATH. The shim normalizes only calls for the exact configured fixture
// destination onto one shared control master; every other call, including
// GitHub, is passed through with its original argv. Only the owner closes the
// master, with the real ssh binary, once the fixture work is verified.
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const environmentKeys = ["SHIBUMI_E2E_SSH_DIR", "SHIBUMI_E2E_SSH_SOCKET", "SHIBUMI_E2E_SSH_TARGET", "SHIBUMI_E2E_SSH_REAL"] as const;

// ssh options that consume the following argv entry as their value.
const separatedOptions = new Set(["B", "b", "c", "D", "E", "e", "F", "I", "i", "J", "L", "l", "m", "O", "o", "P", "p", "Q", "R", "S", "W", "w"]);
const replacedControlKeys = new Set(["controlmaster", "controlpersist", "controlpath"]);

export interface SshAdapter {
  // Only the process that created the transport may close it.
  readonly owner: boolean;
  readonly dir: string;
  readonly socket: string;
  readonly target: string;
  readonly env: Record<string, string>;
  close(): Promise<void>;
}

export type SshInvocation =
  | { action: "exec"; argv: string[] }
  | { action: "skip"; reason: "control-exit" };

function isReplacedControlOption(value: string): boolean {
  const separator = value.indexOf("=");
  const key = (separator < 0 ? value : value.slice(0, separator)).trim().toLowerCase();
  return replacedControlKeys.has(key);
}

function forcedOptions(socket: string): string[] {
  // Our options come first: ssh keeps the first value it sees, so a caller
  // cannot weaken host-key or batch-mode behavior for the managed target.
  return [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ControlMaster=auto",
    "-o", "ControlPersist=600",
    "-S", socket,
  ];
}

function destinationIndex(argv: string[]): number {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") return index + 1;
    if (!arg.startsWith("-") || arg === "-") return index;
    if (arg.length === 2 && separatedOptions.has(arg[1]!)) index++;
  }
  return -1;
}

// Pure argv normalization, shared by the shim and its tests.
export function resolveSshInvocation(config: { target: string; socket: string }, argv: string[]): SshInvocation {
  const destination = destinationIndex(argv);
  // No destination or a different host (GitHub, a human's own server): pass
  // through untouched, including a caller's own -S and -O options.
  if (destination < 0 || destination >= argv.length || argv[destination] !== config.target) return { action: "exec", argv };

  const kept: string[] = [];
  let controlExit = false;
  const refuse = (command: string): never => {
    throw new Error(`Refusing SSH control command ${JSON.stringify(command)} for the managed E2E target`);
  };

  for (let index = 0; index < destination; index++) {
    const arg = argv[index]!;
    if (arg === "-S") { index++; continue; }
    if (arg.startsWith("-S") && arg.length > 2) continue;
    if (arg === "-o") {
      const value = argv[++index] ?? "";
      if (!isReplacedControlOption(value)) kept.push("-o", value);
      continue;
    }
    if (arg.startsWith("-o") && arg.length > 2) {
      if (!isReplacedControlOption(arg.slice(2))) kept.push(arg);
      continue;
    }
    if (arg === "-O") {
      const value = argv[++index] ?? "";
      if (value === "exit" || value === "stop") controlExit = true;
      else refuse(value);
      continue;
    }
    if (arg.startsWith("-O") && arg.length > 2) {
      const value = arg.slice(2);
      if (value === "exit" || value === "stop") controlExit = true;
      else refuse(value);
      continue;
    }
    kept.push(arg);
  }
  // Ship and the runners ask for their own connection to be closed; the shared
  // master must outlive them. The owner closes it after verified restoration.
  if (controlExit) return { action: "skip", reason: "control-exit" };
  return { action: "exec", argv: [...forcedOptions(config.socket), ...kept, ...argv.slice(destination)] };
}

interface AdapterConfig { target: string; socket: string; real: string; }

function configFromEnvironment(): AdapterConfig {
  const values = environmentKeys.map(key => process.env[key]);
  if (values.some(value => !value)) throw new Error("E2E SSH adapter environment is missing or incomplete");
  const [dir, socket, target, real] = values as [string, string, string, string];
  if (socket !== join(dir, "control-%C")) throw new Error("E2E SSH adapter socket is not run-private");
  if (!isAbsolute(real)) throw new Error("E2E SSH adapter needs an absolute ssh executable");
  return { target, socket, real };
}

// Entry point of the generated `ssh` shim. stdin/stdout/stderr are inherited so
// binary uploads, TTY allocation and compression flags behave unchanged.
export async function runSshAdapter(argv: string[]): Promise<number> {
  let config: AdapterConfig;
  let invocation: SshInvocation;
  try {
    config = configFromEnvironment();
    invocation = resolveSshInvocation(config, argv);
  } catch (error) {
    console.error(`e2e ssh adapter: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (invocation.action === "skip") return 0;
  // Bun.spawn's default env is a snapshot from process start, so pass the
  // current environment explicitly (ssh needs SSH_AUTH_SOCK, HOME, PATH).
  const child = Bun.spawn([config.real, ...invocation.argv], { env: { ...process.env }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await child.exited;
}

function adapterEnvironment(dir: string, socket: string, target: string, real: string): Record<string, string> {
  return {
    PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    SHIBUMI_E2E_SSH_DIR: dir,
    SHIBUMI_E2E_SSH_SOCKET: socket,
    SHIBUMI_E2E_SSH_TARGET: target,
    SHIBUMI_E2E_SSH_REAL: real,
  };
}

async function privateDirectory(dir: string): Promise<void> {
  const info = await stat(dir);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new Error("E2E SSH adapter directory must be a mode 0700 directory");
}

function shimSource(): string {
  return [
    "#!/usr/bin/env bun",
    "// Generated by scripts/e2e-ssh.ts. One run-private SSH transport; do not edit.",
    `import { runSshAdapter } from ${JSON.stringify(join(import.meta.dir, "e2e-ssh.ts"))};`,
    "process.exit(await runSshAdapter(Bun.argv.slice(2)));",
    "",
  ].join("\n");
}

// Creates the transport. `real` is a test seam; production runs pin the ssh
// found on the unmodified PATH before any child sees the shim directory.
export async function startSshAdapter(target: string, options: { real?: string } = {}): Promise<SshAdapter> {
  const real = options.real ?? Bun.which("ssh");
  if (!real || !isAbsolute(real)) throw new Error("E2E SSH adapter could not pin an absolute ssh executable");
  if (!Bun.which("bun")) throw new Error("E2E SSH adapter shim needs bun on PATH");
  // Short path: a Unix socket address is limited, so `%C` keeps the name small.
  const dir = await mkdtemp(join(tmpdir(), "shibumi-e2e-ssh-"));
  try {
    await chmod(dir, 0o700);
    const socket = join(dir, "control-%C");
    // `%C` expands to a 40-character hash, so compare the real address length.
    const expanded = socket.length - 2 + 40;
    if (expanded > 100) throw new Error("E2E SSH adapter socket path is too long");
    await writeFile(join(dir, "ssh"), shimSource(), { mode: 0o700 });
    await chmod(join(dir, "ssh"), 0o700);
    return createAdapter({ owner: true, dir, socket, target, real });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

// A nested runner reuses the parent's validated transport; it never starts a
// second one and never owns the shared master.
export async function inheritedSshAdapter(target: string): Promise<SshAdapter | undefined> {
  if (environmentKeys.every(key => process.env[key] === undefined)) return undefined;
  const config = configFromEnvironment();
  if (config.target !== target) throw new Error("E2E SSH adapter belongs to a different target");
  const dir = process.env.SHIBUMI_E2E_SSH_DIR!;
  if (!isAbsolute(dir)) throw new Error("E2E SSH adapter directory is not absolute");
  await privateDirectory(dir);
  return createAdapter({ owner: false, dir, socket: config.socket, target, real: config.real });
}

function createAdapter(state: { owner: boolean; dir: string; socket: string; target: string; real: string }): SshAdapter {
  let closed = false;
  return {
    owner: state.owner,
    dir: state.dir,
    socket: state.socket,
    target: state.target,
    env: adapterEnvironment(state.dir, state.socket, state.target, state.real),
    async close() {
      if (closed || !state.owner) return;
      closed = true;
      // Real ssh, once: the shim would suppress its own -O exit. The close is
      // time-bounded so a wedged connection cannot block fixture cleanup.
      const child = Bun.spawn([state.real, "-S", state.socket, "-O", "exit", "--", state.target], {
        env: { ...process.env }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<"timeout">(resolve => { timer = setTimeout(() => resolve("timeout"), 10_000); });
      try {
        if (await Promise.race([child.exited.then(() => "exit" as const), expired]) === "timeout") {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          await child.exited.catch(() => 1);
        }
      } finally {
        clearTimeout(timer);
      }
      await rm(state.dir, { recursive: true, force: true });
    },
  };
}
