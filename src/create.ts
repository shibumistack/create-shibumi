import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { validateName, type TemplateId } from "./args";

export interface CreateOptions {
  name: string;
  parentDir: string;
  template: TemplateId;
  git: boolean;
  install: boolean;
  templatesDir?: string;
}

export interface RunResult {
  ok: boolean;
  code: number;
}

export type Runner = (cmd: string[], cwd: string) => Promise<RunResult>;

export class CreateError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export type StepReporter = (step: string) => void;

// Children spawned by the default runner, killed before signal cleanup so a
// running `git`/`bun install` cannot recreate temp contents after removal.
const activeChildren = new Set<ReturnType<typeof Bun.spawn>>();

function killActiveChildren(): void {
  for (const child of activeChildren) {
    try {
      // SIGKILL: the signal handler cannot await child exit, so the child
      // must die immediately or it could recreate temp contents mid-removal.
      child.kill("SIGKILL");
    } catch {
      // Child already gone.
    }
  }
}

async function defaultRun(cmd: string[], cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  activeChildren.add(proc);
  try {
    const code = await proc.exited;
    return { ok: code === 0, code };
  } finally {
    activeChildren.delete(proc);
  }
}

const DEFAULT_TEMPLATES_DIR = join(import.meta.dir, "templates");

function removeVerified(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Retry once, then report below.
    }
    if (!existsSync(path)) return true;
  }
  process.stderr.write(`Could not remove temporary directory, delete it manually: ${path}\n`);
  return false;
}

/**
 * Atomic scaffold: build the project in a temp sibling directory created
 * exclusively via mkdtemp, verify it, reserve the destination with mkdir,
 * then rename into place (rename only ever replaces the empty directory this
 * process created). On any failure, cancellation, or signal the destination
 * is never left populated and the temp directory is removed. Never overwrites
 * existing content. Never stages or commits in git.
 */
export async function createProject(
  opts: CreateOptions,
  run: Runner = defaultRun,
  onStep: StepReporter = () => {}
): Promise<{ dest: string }> {
  const nameError = validateName(opts.name);
  if (nameError) {
    throw new CreateError(nameError, 2);
  }

  const dest = join(opts.parentDir, opts.name);
  if (existsSync(dest)) {
    throw new CreateError(
      `Destination already exists: ${dest}\nChoose another name or remove it first.`
    );
  }

  const templatesDir = opts.templatesDir ?? DEFAULT_TEMPLATES_DIR;
  const templateSrc = join(templatesDir, opts.template);
  if (!existsSync(templateSrc)) {
    throw new CreateError(`Template "${opts.template}" is not available in this build.`);
  }

  // mkdtemp creates the directory exclusively, so concurrent creators can
  // never share (or delete) each other's temp path.
  const tmp = mkdtempSync(join(dirname(dest), `.${opts.name}.shibumi-tmp-`));
  let reserved: string | null = null;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    killActiveChildren();
    removeVerified(tmp);
    if (reserved) removeVerified(reserved);
  };
  const onSigint = () => {
    cleanup();
    process.exit(130);
  };
  const onSigterm = () => {
    cleanup();
    process.exit(143);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    onStep("copy");
    // tmp was created exclusively by mkdtemp above and is empty.
    cpSync(templateSrc, tmp, { recursive: true });

    // npm pack always strips .gitignore files, so templates store the file
    // as "gitignore" and it is renamed into place here.
    const packSafeIgnore = join(tmp, "gitignore");
    if (existsSync(packSafeIgnore)) {
      renameSync(packSafeIgnore, join(tmp, ".gitignore"));
    }

    const pkgPath = join(tmp, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        name?: string;
        scripts?: Record<string, string>;
      };
      const templateName = pkg.name;
      pkg.name = opts.name;
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

      // Keep the shipped lockfile's workspace name in sync with the rename.
      const lockPath = join(tmp, "bun.lock");
      if (templateName && existsSync(lockPath)) {
        const lock = readFileSync(lockPath, "utf8");
        writeFileSync(
          lockPath,
          lock.replace(`"name": "${templateName}"`, `"name": "${opts.name}"`)
        );
      }

      // Templates whose scripts use the Ship client get the vendored,
      // checksum-locked copy; it is package-level, not per-template. The
      // lock ships in the tarball and is verified here at scaffold time, so
      // a substituted ship.ts in a tampered artifact fails loudly.
      if (pkg.scripts?.ship) {
        const shipSrc = join(templatesDir, "ship.ts");
        const lockPath = join(templatesDir, "..", "..", "scripts", "ship.lock.json");
        if (!existsSync(shipSrc)) {
          throw new CreateError(`Vendored Ship client missing at ${shipSrc}; aborting.`);
        }
        if (opts.templatesDir === undefined) {
          const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { sha256: string };
          const digest = new Bun.CryptoHasher("sha256")
            .update(await Bun.file(shipSrc).arrayBuffer())
            .digest("hex");
          if (digest !== lock.sha256) {
            throw new CreateError(
              `Vendored Ship client does not match its checksum lock; the package may be corrupt. Reinstall create-shibumi.`
            );
          }
        }
        mkdirSync(join(tmp, "scripts"), { recursive: true });
        cpSync(shipSrc, join(tmp, "scripts", "ship.ts"));
      }

      // Same pattern for the extension installer: vendored, checksum-locked,
      // verified at scaffold time. Extension bundles are embedded in the
      // file, so `bun run shibumi add` never touches the network.
      if (pkg.scripts?.shibumi) {
        const shibumiSrc = join(templatesDir, "shibumi.ts");
        const shibumiLockPath = join(templatesDir, "..", "..", "scripts", "shibumi.lock.json");
        if (!existsSync(shibumiSrc)) {
          throw new CreateError(`Vendored extension installer missing at ${shibumiSrc}; aborting.`);
        }
        if (opts.templatesDir === undefined) {
          const lock = JSON.parse(readFileSync(shibumiLockPath, "utf8")) as { sha256: string };
          const digest = new Bun.CryptoHasher("sha256")
            .update(await Bun.file(shibumiSrc).arrayBuffer())
            .digest("hex");
          if (digest !== lock.sha256) {
            throw new CreateError(
              `Vendored extension installer does not match its checksum lock; the package may be corrupt. Reinstall create-shibumi.`
            );
          }
        }
        mkdirSync(join(tmp, "scripts"), { recursive: true });
        cpSync(shibumiSrc, join(tmp, "scripts", "shibumi.ts"));
      }
    }

    if (opts.git) {
      onStep("git");
      const gitAvailable = await run(["git", "--version"], dirname(tmp));
      if (!gitAvailable.ok) {
        throw new CreateError(`git not found. Install git or re-run with --no-git.`);
      }
      const init = await run(["git", "init"], tmp);
      if (!init.ok) {
        throw new CreateError(`git init failed. Re-run with --no-git and initialize manually.`);
      }
      // Nothing is staged or committed; the first commit belongs to the user.
    }

    if (opts.install) {
      onStep("install");
      const install = await run(["bun", "install"], tmp);
      if (!install.ok) {
        throw new CreateError(
          `Dependency install failed. Re-run with --no-install, then run "bun install" inside the project.`
        );
      }
    }

    onStep("verify");
    if (existsSync(join(templateSrc, "package.json")) && !existsSync(pkgPath)) {
      throw new CreateError(`Generated project is missing package.json; aborting.`);
    }

    // Reserve the destination: mkdir fails if anything appeared meanwhile,
    // and rename below only ever replaces this empty reservation.
    try {
      mkdirSync(dest);
      reserved = dest;
    } catch {
      throw new CreateError(
        `Destination was created while scaffolding: ${dest}\nNothing was written there. Re-run with a different name.`
      );
    }
    try {
      renameSync(tmp, dest);
      reserved = null;
    } catch {
      throw new CreateError(
        `Could not move the project into place: ${dest}\nNothing was written there.`
      );
    }

    return { dest };
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    cleanup();
  }
}
