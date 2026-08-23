#!/usr/bin/env bun

import { cancel, confirm, intro, isCancel, outro, select, spinner, text } from "@clack/prompts";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { HELP_TEXT, parseArgs, validateName, type TemplateId } from "./args";
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

async function main(): Promise<void> {
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

  if (args.outputDir !== undefined || args.buildScript !== undefined || args.spa) {
    process.stderr.write(
      `--output-dir, --build-script, and --spa are not implemented yet; the static template scaffolds its default layout for now.\n`
    );
    process.exit(2);
  }

  const interactive = !args.yes;
  if (interactive && !process.stdin.isTTY) {
    process.stderr.write(
      `No interactive terminal. Use --yes with a project name and --template.\n`
    );
    process.exit(2);
  }

  intro("渋み shibumi");

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
    const answer = await select({
      message: "What are you shipping?",
      options: [
        { value: "static" as TemplateId, label: "Static output: any framework, prebuilt files" },
        { value: "web" as TemplateId, label: "Bun web app: Hono, Alpine, Zod" },
        { value: "full-stack" as TemplateId, label: "Bun full-stack app: adds Drizzle and SQLite" },
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
      const proc = Bun.spawn(["bun", "run", "ship:setup"], {
        cwd: dest,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const code = await proc.exited;
      if (code !== 0) {
        process.stderr.write(
          `ship:setup did not finish. Your project is intact; run "bun ship:setup" inside ${name} to retry.\n`
        );
        process.exit(1);
      }
    } else {
      process.stdout.write(
        `This template has no ship:setup yet. Run "bun ship:setup" inside ${name} once it does.\n`
      );
    }
  }

  outro(`cd ${name} && bun dev`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Something went wrong: ${message}\n`);
  process.exit(1);
});
