import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DEFAULT_TEMPLATES_DIR = join(import.meta.dir, "templates");
const CLACK_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  }
).dependencies["@clack/prompts"]!;

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
}): DetectedOutput | undefined {
  const dependencies = input.dependencies ?? {};
  const dep = (name: string) => name in dependencies;
  const file = (name: string) => input.files.includes(name);
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
    if (file(candidate)) return { framework: "existing build output", outputDir: candidate, source: "directory" };
  }
  if (file("public")) return { framework: "plain files", outputDir: "public", source: "directory" };
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
    throw new AdoptError(`Vendored Ship client missing at ${shipPath}; aborting.`);
  }
  if (templatesDir === DEFAULT_TEMPLATES_DIR) {
    const lock = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "scripts", "ship.lock.json"), "utf8")
    ) as { sha256: string };
    const digest = new Bun.CryptoHasher("sha256").update(readFileSync(shipPath)).digest("hex");
    if (digest !== lock.sha256) {
      throw new AdoptError(
        `Vendored Ship client does not match its checksum lock; the package may be corrupt. Reinstall create-shibumi.`
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
}

/**
 * Vendor the Ship client into an existing project instead of scaffolding a new
 * one. Files that already exist are never rewritten: they are reported as kept
 * so the transcript says what this project already owned.
 */
export async function adoptProject(opts: AdoptOptions): Promise<AdoptResult> {
  const problem = opts.ship.staticOutputDirProblem(opts.outputDir);
  if (problem) throw new AdoptError(problem, 2);

  const templatesDir = opts.templatesDir ?? DEFAULT_TEMPLATES_DIR;
  const written: string[] = [];
  const kept: string[] = [];

  const write = (relative: string, contents: string): void => {
    const target = join(opts.root, relative);
    if (existsSync(target)) {
      kept.push(relative);
      return;
    }
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents, { mode: 0o644 });
    written.push(relative);
  };

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
  const pkg = (existsSync(packagePath)
    ? JSON.parse(readFileSync(packagePath, "utf8"))
    : {
        name: opts.root.split("/").pop()?.toLowerCase().replace(/[^a-z0-9._-]+/g, "-") || "app",
        private: true,
        type: "module",
      }) as {
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
  if (!existsSync(packagePath)) written.push("package.json");

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
  // empty node_modules disables auto-install, so the dependency is declared.
  if (!pkg.dependencies?.["@clack/prompts"] && !pkg.devDependencies?.["@clack/prompts"]) {
    pkg.devDependencies = { ...pkg.devDependencies, "@clack/prompts": CLACK_VERSION };
  }
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`, { mode: 0o644 });

  for (const [name, contents] of Object.entries(
    opts.ship.staticDeploymentFileTemplates({
      outputDir: opts.outputDir,
      buildScript: opts.buildScript,
      spa: opts.spa,
    })
  )) {
    write(name, contents);
  }
  if (opts.spa) write("scripts/static-server.ts", opts.ship.staticServerSource(opts.outputDir));

  return { written, kept, scripts: added };
}
