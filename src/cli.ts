#!/usr/bin/env bun

import { cancel, confirm, intro, isCancel, log, outro, select, spinner, text } from "@clack/prompts";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { AdoptError, adoptProject, detectBuildOutput, loadShipStatic } from "./adopt";
import {
  HELP_TEXT,
  bunVersionProblem,
  parseArgs,
  validateName,
  type ParsedArgs,
  type TemplateId,
} from "./args";
import { CreateError, createProject } from "./create";

const VERSION = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

const CANCELLED = "Cancelled. Nothing was created.";

function exitCancelled(): never {
  cancel(CANCELLED);
  process.exit(130);
}

// Emit the vendored extension installer so a generated project can re-vendor it
// (`bun run shibumi update` runs `bunx create-shibumi@latest --print-installer`).
// Verifies the checksum lock before printing, so a corrupt package cannot ship
// a tampered installer through this path.
async function printInstaller(): Promise<never> {
  const installer = join(import.meta.dir, "templates", "shibumi.ts");
  const lockPath = join(import.meta.dir, "..", "scripts", "shibumi.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { sha256: string };
  const bytes = await Bun.file(installer).arrayBuffer();
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (digest !== lock.sha256) {
    process.stderr.write("Vendored installer does not match its checksum lock; reinstall create-shibumi.\n");
    process.exit(1);
  }
  process.stdout.write(readFileSync(installer, "utf8"));
  process.exit(0);
}

const dim = (value: string) => `\x1b[2m${value}\x1b[22m`;
const accent = (value: string) => `\x1b[38;5;208m${value}\x1b[0m`;

// Offer the first deployment in the same run. Both entry paths end here, so
// "Deploy to a VPS now?" means the same thing whether the project was just
// scaffolded or just adopted.
async function runShipSetup(dest: string, label: string): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "ship:setup"], {
    cwd: dest,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    process.stderr.write(
      `ship:setup did not finish. Your project is intact; run "bun ship:setup" ${label} to retry.\n`
    );
    process.exit(1);
  }
}

/**
 * `bun create shibumi .`: vendor the Ship client into the project that is
 * already here instead of scaffolding a new one. Nothing that exists is
 * overwritten, and no git or install step runs.
 */
async function adoptExisting(args: ParsedArgs): Promise<void> {
  const root = process.cwd();
  const entries = readdirSync(root).filter((entry) => entry !== ".git");
  if (entries.length === 0) {
    process.stderr.write(
      `Nothing to adopt: this directory is empty.\nRun bun create shibumi <name> to scaffold a new project.\n`
    );
    process.exit(2);
  }

  const packagePath = join(root, "package.json");
  const pkg = (existsSync(packagePath)
    ? JSON.parse(readFileSync(packagePath, "utf8"))
    : {}) as {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const detected = detectBuildOutput({
    dependencies: { ...pkg.dependencies, ...pkg.devDependencies },
    files: entries,
  });
  log.info(
    detected
      ? `Existing project found (${detected.framework} detected)`
      : "Existing project found"
  );

  const interactive = !args.yes;
  if (interactive) {
    const proceed = await confirm({
      message: "Add deploy tooling to this project?",
      active: "Yes",
      inactive: "No",
      initialValue: true,
    });
    if (isCancel(proceed) || !proceed) {
      cancel("Cancelled. Nothing was changed.");
      process.exit(130);
    }
  }

  const ship = await loadShipStatic();
  let outputDir = detected?.outputDir;
  if (interactive) {
    const elsewhere = "";
    if (detected) {
      const choice = await select({
        message: "Built site directory?",
        options: [
          { value: detected.outputDir, label: `${detected.outputDir}/ ${dim("(detected)")}` },
          { value: elsewhere, label: "Somewhere else" },
        ],
      });
      if (isCancel(choice)) exitCancelled();
      outputDir = choice === elsewhere ? undefined : choice;
    }
    if (!outputDir) {
      const answer = await text({
        message: "Built site directory?",
        placeholder: detected?.outputDir ?? "dist",
        validate: (value) =>
          value ? ship.staticOutputDirProblem(value) : "Enter the directory your build writes",
      });
      if (isCancel(answer)) exitCancelled();
      outputDir = answer;
    }
  }
  if (!outputDir) {
    process.stderr.write(
      `Could not detect the built site directory.\nRun bun create shibumi . in a terminal to choose one.\n`
    );
    process.exit(1);
  }

  let result;
  try {
    result = await adoptProject({
      root,
      outputDir,
      buildScript: typeof pkg.scripts?.build === "string" ? "build" : undefined,
      spa: args.spa,
      ship,
    });
  } catch (err) {
    if (err instanceof AdoptError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }

  log.success(`Wrote ${result.written.join(", ")}`);
  if (result.scripts.length > 0) log.success(`Added scripts: ${result.scripts.join(", ")}`);
  if (result.kept.length > 0) log.info(`Left untouched: ${result.kept.join(", ")}`);

  let deployNow = false;
  if (interactive) {
    const answer = await confirm({
      message: "Deploy to a VPS now?",
      active: "Yes",
      inactive: "Later",
      initialValue: false,
    });
    if (isCancel(answer)) exitCancelled();
    deployNow = answer;
  }
  if (deployNow) await runShipSetup(root, "here");

  log.message(
    [
      deployNow
        ? `${accent("next")}  bun ship          ${dim("deploy your first commit")}`
        : `${accent("next")}  bun ship:setup    ${dim("connect your VPS when you're ready")}`,
      "",
      dim(`Deployments serve ${outputDir}/. Review the generated Dockerfile and compose.yaml.`),
    ].join("\n")
  );
  outro(`Docs: ${accent("https://shibumistack.dev/docs")}`);
}

async function main(): Promise<void> {
  if (process.argv.slice(2).includes("--print-installer")) {
    await printInstaller();
  }
  const bunProblem = bunVersionProblem(Bun.version);
  if (bunProblem) {
    process.stderr.write(`${bunProblem}\n`);
    process.exit(2);
  }
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\nRun create-shibumi --help for usage.\n`);
    process.exit(2);
  }
  const args = parsed.args;

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }

  const interactive = !args.yes;
  if (interactive && !process.stdin.isTTY) {
    process.stderr.write(
      `No interactive terminal. Use --yes with a project name and --template.\n`
    );
    process.exit(2);
  }

  intro("渋み shibumi");

  if (args.adopt) {
    await adoptExisting(args);
    return;
  }

  let name: string;
  if (args.name) {
    name = args.name;
  } else {
    const answer = await text({
      message: "Project name?",
      placeholder: "my-app",
      validate: (value) => validateName(value ?? "") ?? undefined,
    });
    if (isCancel(answer)) exitCancelled();
    name = answer;
  }

  let template: TemplateId;
  if (args.template) {
    template = args.template;
  } else {
    const detail = (value: string) => `\n    ${dim(value)}`;
    const answer = await select({
      message: "What are you shipping?",
      options: [
        {
          value: "full-stack" as TemplateId,
          label: `Bun full-stack app ${dim("(recommended)")}${detail("Hono, Alpine, and SQLite with migrations and backups")}`,
        },
        {
          value: "blog" as TemplateId,
          label: `Blog${detail("Astro: posts, RSS, sitemap, SEO meta, llms.txt")}`,
        },
        {
          value: "static" as TemplateId,
          label: `Static site${detail("Any framework's build output: dist/, public/, _site/, or plain files")}`,
        },
      ],
    });
    if (isCancel(answer)) exitCancelled();
    template = answer as TemplateId;
  }

  let deployNow = false;
  if (interactive) {
    const answer = await confirm({
      message: "Deploy to a VPS now?",
      active: "Yes",
      inactive: "Later",
      initialValue: false,
    });
    if (isCancel(answer)) exitCancelled();
    deployNow = answer;
  }

  const s = spinner();
  s.start("Creating project");
  let dest: string;
  try {
    const result = await createProject(
      {
        name,
        parentDir: process.cwd(),
        template,
        git: args.git,
        install: args.install,
      },
      undefined,
      (step) => {
        if (step === "git") s.message("Initializing git");
        else if (step === "install") s.message("Installing dependencies");
      }
    );
    dest = result.dest;
    s.stop(`Created ${name}`);
    // Receipt: the finished transcript documents what actually happened.
    log.success("Template copied");
    if (args.git) log.success("Git initialized; nothing committed, the first commit is yours");
    else log.info("Git skipped; run git init when you want history");
    if (args.install) log.success("Dependencies installed");
    else log.info("Install skipped; run bun install inside the project");
    if (existsSync(join(result.dest, "scripts", "ship.ts"))) {
      log.success("Ship client vendored (scripts/ship.ts)");
    }
  } catch (err) {
    if (err instanceof CreateError) {
      s.stop("Failed");
      process.stderr.write(`${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }

  // Post-create phase: runs only after the atomic rename. Cancelling here
  // leaves a complete, healthy project behind.
  if (deployNow) {
    const pkg = JSON.parse(readFileSync(join(dest, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (pkg.scripts?.["ship:setup"] && existsSync(join(dest, "scripts", "ship.ts"))) {
      await runShipSetup(dest, `inside ${name}`);
    } else {
      process.stdout.write(
        `This template has no ship:setup yet. Run "bun ship:setup" inside ${name} once it does.\n`
      );
    }
  }

  log.message(
    [
      `${accent("next")}  cd ${name}`,
      `      bun dev           ${dim("start the dev server (ctrl+c stops it)")}`,
      deployNow
        ? `      bun ship          ${dim("deploy your first commit")}`
        : `      bun ship:setup    ${dim("connect your VPS when you're ready")}`,
      "",
      dim("agents.md tells your coding agent the house rules."),
    ].join("\n")
  );
  outro(`Docs: ${accent("https://shibumistack.dev/docs")}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Something went wrong: ${message}\n`);
  process.exit(1);
});
