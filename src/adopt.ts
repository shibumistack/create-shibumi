import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DEFAULT_TEMPLATES_DIR = join(import.meta.dir, "templates");
export const CLACK_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  }
).dependencies["@clack/prompts"]!;

/**
 * How to install the client's one dependency here. A project with an npm or
 * pnpm lockfile must not get a bun.lock dropped beside it, so those get the
 * matching command to run instead of a silent second lockfile.
 */
export function dependencyInstall(lockfiles: string[]): { command: string[]; manual?: string } {
  const pinned = `@clack/prompts@${CLACK_VERSION}`;
  if (lockfiles.includes("package-lock.json")) return { command: [], manual: `npm install --save-dev ${pinned}` };
  if (lockfiles.includes("pnpm-lock.yaml")) return { command: [], manual: `pnpm add -D ${pinned}` };
  if (lockfiles.includes("yarn.lock")) return { command: [], manual: `yarn add --dev --exact ${pinned}` };
  // --exact keeps the version this package pins, instead of widening it to ^.
  return { command: ["bun", "add", "--dev", "--exact", pinned] };
}

export interface DetectedOutput {
  framework: string;
  outputDir: string;
  // "framework" means a build tool named the directory; "directory" means the
  // directory was simply there, which a Bun server app's dist/ also satisfies.
  source: "framework" | "directory";
}

/**
 * Where this project's build lands. Framework signals come first (Astro and
 * Eleventy both pull Vite in, so a bare Vite match must lose), then a build
 * directory that is already on disk, then plain files under public/.
 */
export function detectBuildOutput(input: {
  dependencies?: Record<string, unknown>;
  files: string[];
  directories?: string[];
}): DetectedOutput | undefined {
  const dependencies = input.dependencies ?? {};
  const dep = (name: string) => name in dependencies;
  const file = (name: string) => input.files.includes(name);
  // A plain file named dist must never satisfy a directory fallback.
  const directory = (name: string) => (input.directories ?? []).includes(name);
  const config = (base: string) =>
    ["js", "mjs", "cjs", "ts"].some((extension) => file(`${base}.${extension}`));

  const framework = (name: string, outputDir: string): DetectedOutput => ({ framework: name, outputDir, source: "framework" });
  if (dep("astro") || config("astro.config")) return framework("Astro", "dist");
  if (dep("@11ty/eleventy") || config(".eleventy") || config("eleventy.config")) {
    return framework("Eleventy", "_site");
  }
  if (dep("next") || config("next.config")) return framework("Next.js", "out");
  if (dep("vite") || config("vite.config")) return framework("Vite", "dist");
  for (const candidate of ["dist", "_site", "out", "build"]) {
    if (directory(candidate)) return { framework: "existing build output", outputDir: candidate, source: "directory" };
  }
  if (directory("public")) return { framework: "plain files", outputDir: "public", source: "directory" };
  return undefined;
}

export function shipScripts(config: {
  outputDir: string;
  buildScript?: string;
  spa: boolean;
}): Record<string, string> {
  const setup = [
    "bun scripts/ship.ts --setup --static",
    `--output-dir ${config.outputDir}`,
    ...(config.buildScript ? [`--build-script ${config.buildScript}`] : []),
    config.spa ? "--spa" : "--no-spa",
  ].join(" ");
  return {
    ship: "bun scripts/ship.ts",
    "ship:setup": setup,
    "ship:update": "bun scripts/ship.ts --update",
    "ship:status": "bun scripts/ship.ts --status",
    "ship:logs": "bun scripts/ship.ts --logs",
    "ship:webhook": "bun scripts/ship.ts --webhook",
  };
}

// The generators for the static image live in the Ship client, so adopted
// projects get byte-identical deployment files to the ones ship:setup writes.
// The specifier stays computed on purpose: the client is a vendored artifact
// with its own compiler settings and must not join this package's tsc program.
export interface ShipStatic {
  staticDeploymentFileTemplates(config: {
    outputDir: string;
    buildScript?: string;
    spa: boolean;
  }): Record<string, string>;
  staticServerSource(outputDir: string): string;
  staticOutputDirProblem(value: string): string | undefined;
}

export class AdoptError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function verifiedShipPath(templatesDir: string): string {
  const shipPath = join(templatesDir, "ship.ts");
  if (!existsSync(shipPath)) {
    throw new AdoptError(`Packaged deploy script missing at ${shipPath}; aborting.`);
  }
  if (templatesDir === DEFAULT_TEMPLATES_DIR) {
    const lock = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "scripts", "ship.lock.json"), "utf8")
    ) as { sha256: string };
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(shipPath)).digest("hex");
    if (digest !== lock.sha256) {
      throw new AdoptError(
        `Packaged deploy script does not match its checksum lock; the package may be corrupt. Reinstall create-shibumi.`
      );
    }
  }
  return shipPath;
}

export async function loadShipStatic(templatesDir = DEFAULT_TEMPLATES_DIR): Promise<ShipStatic> {
  return (await import(verifiedShipPath(templatesDir))) as ShipStatic;
}

export interface AdoptOptions {
  root: string;
  outputDir: string;
  buildScript?: string;
  spa: boolean;
  ship: ShipStatic;
  templatesDir?: string;
}

export interface AdoptResult {
  written: string[];
  kept: string[];
  scripts: string[];
  dependency: boolean;
}

function trackedState(root: string, path: string): "tracked" | "untracked" | "no-repository" {
  const listed = Bun.spawnSync(["git", "ls-files", "--", path], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (listed.exitCode !== 0) return "no-repository";
  return listed.stdout.toString().trim() ? "tracked" : "untracked";
}

/**
 * Vendor the Ship client into an existing project instead of scaffolding a new
 * one. Refuses rather than reinterpreting a project's own packaging: deployment
 * files that already exist may build or run something else entirely.
 */
export async function adoptProject(opts: AdoptOptions): Promise<AdoptResult> {
  const problem = opts.ship.staticOutputDirProblem(opts.outputDir);
  if (problem) throw new AdoptError(problem, 2);

  const templates = opts.ship.staticDeploymentFileTemplates({
    outputDir: opts.outputDir,
    buildScript: opts.buildScript,
    spa: opts.spa,
  });
  // Same refusal ship:setup makes: a compose file carrying shibumi static
  // labels next to somebody else's Dockerfile deploys the wrong artifact.
  const targets = [...Object.keys(templates), ...(opts.spa ? ["scripts/static-server.ts"] : [])];
  const conflicts = targets.filter((name) => existsSync(join(opts.root, name)));
  if (conflicts.length > 0) {
    throw new AdoptError(
      `Adopting would generate ${conflicts.join(", ")}, which already exist and may package or run something else.\n\nNext: remove or rename them, then run bun create shibumi . again.`
    );
  }
  // Without a build script the image can only contain what the commit
  // contains, so the output has to be in git already.
  const state = opts.buildScript ? "tracked" : trackedState(opts.root, opts.outputDir);
  if (state !== "tracked") {
    const next = state === "no-repository"
      ? `git init && git add ${opts.outputDir} && git commit -m "Add site"`
      : `commit ${opts.outputDir}/`;
    throw new AdoptError(
      `Without a build script, ${opts.outputDir}/ must be committed so shipped images match the exact commit.\n\nNext: ${next}, or add a build script to package.json, then run bun create shibumi . again.`
    );
  }

  const templatesDir = opts.templatesDir ?? DEFAULT_TEMPLATES_DIR;
  const written: string[] = [];
  const kept: string[] = [];

  if (existsSync(join(opts.root, "scripts", "ship.ts"))) {
    kept.push("scripts/ship.ts");
  } else {
    mkdirSync(join(opts.root, "scripts"), { recursive: true });
    copyFileSync(verifiedShipPath(templatesDir), join(opts.root, "scripts", "ship.ts"));
    written.push("scripts/ship.ts");
  }

  // Script-less generators (Jekyll) have no package.json; the ship commands
  // and the client's own dependency need one.
  const packagePath = join(opts.root, "package.json");
  const before = existsSync(packagePath) ? readFileSync(packagePath, "utf8") : undefined;
  const pkg = (before === undefined
    ? {
        name: opts.root.split("/").pop()?.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "app",
        private: true,
        type: "module",
      }
    : JSON.parse(before)) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  const scripts = pkg.scripts ?? {};
  const added: string[] = [];
  for (const [name, command] of Object.entries(
    shipScripts({ outputDir: opts.outputDir, buildScript: opts.buildScript, spa: opts.spa })
  )) {
    if (scripts[name]) continue;
    scripts[name] = command;
    added.push(name);
  }
  pkg.scripts = scripts;
  // The vendored client imports @clack/prompts; an adopted project with an
  // existing node_modules gets no auto-install, so the dependency is declared
  // and installed.
  const dependency = !pkg.dependencies?.["@clack/prompts"] && !pkg.devDependencies?.["@clack/prompts"];
  if (dependency) pkg.devDependencies = { ...pkg.devDependencies, "@clack/prompts": CLACK_VERSION };
  const after = `${JSON.stringify(pkg, null, 2)}\n`;
  if (after !== before) {
    writeFileSync(packagePath, after, { mode: 0o644 });
    written.push("package.json");
  } else {
    kept.push("package.json");
  }

  for (const [name, contents] of Object.entries(templates)) {
    writeFileSync(join(opts.root, name), contents, { mode: 0o644 });
    written.push(name);
  }
  if (opts.spa) {
    mkdirSync(join(opts.root, "scripts"), { recursive: true });
    writeFileSync(join(opts.root, "scripts", "static-server.ts"), opts.ship.staticServerSource(opts.outputDir), { mode: 0o644 });
    written.push("scripts/static-server.ts");
  }

  return { written, kept, scripts: added, dependency };
}
