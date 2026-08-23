export const TEMPLATES = ["static", "web", "full-stack"] as const;
export type TemplateId = (typeof TEMPLATES)[number];

export interface ParsedArgs {
  help: boolean;
  version: boolean;
  yes: boolean;
  git: boolean;
  install: boolean;
  spa: boolean;
  name?: string;
  template?: TemplateId;
  outputDir?: string;
  buildScript?: string;
}

export type ParseResult =
  | { ok: true; args: ParsedArgs }
  | { ok: false; error: string };

// Lowercase npm-style project names only; also the directory name.
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const BUILD_SCRIPT_PATTERN = /^[A-Za-z0-9:_-]+$/;

const VALUE_FLAGS = new Set(["--template", "--output-dir", "--build-script"]);
const BOOLEAN_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "--yes",
  "-y",
  "--no-git",
  "--no-install",
  "--spa",
]);

export function validateName(name: string): string | null {
  if (!NAME_PATTERN.test(name)) {
    return `Invalid project name "${name}". Use lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.`;
  }
  if (name.length > 128) {
    return `Project name too long (max 128 characters).`;
  }
  return null;
}

export function validateOutputDir(dir: string): string | null {
  if (dir.length === 0) return `--output-dir requires a value.`;
  if (dir.startsWith("/") || dir.startsWith("\\") || /^[A-Za-z]:/.test(dir)) {
    return `--output-dir must be a relative path inside the project, got "${dir}".`;
  }
  const segments = dir.split(/[\\/]/);
  if (segments.some((s) => s === ".." || s === "")) {
    return `--output-dir must not contain ".." or empty segments, got "${dir}".`;
  }
  return null;
}

export function parseArgs(argv: string[]): ParseResult {
  const args: ParsedArgs = {
    help: false,
    version: false,
    yes: false,
    git: true,
    install: true,
    spa: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!;

    if (!raw.startsWith("-")) {
      positionals.push(raw);
      continue;
    }

    let flag = raw;
    let inlineValue: string | undefined;
    const eq = raw.indexOf("=");
    if (raw.startsWith("--") && eq !== -1) {
      flag = raw.slice(0, eq);
      inlineValue = raw.slice(eq + 1);
    }

    if (VALUE_FLAGS.has(flag)) {
      let value = inlineValue;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          return { ok: false, error: `${flag} requires a value.` };
        }
        value = next;
        i++;
      }
      if (flag === "--template") {
        if (!(TEMPLATES as readonly string[]).includes(value)) {
          return {
            ok: false,
            error: `Unknown template "${value}". Available: ${TEMPLATES.join(", ")}.`,
          };
        }
        args.template = value as TemplateId;
      } else if (flag === "--output-dir") {
        const err = validateOutputDir(value);
        if (err) return { ok: false, error: err };
        args.outputDir = value;
      } else if (flag === "--build-script") {
        if (!BUILD_SCRIPT_PATTERN.test(value)) {
          return {
            ok: false,
            error: `--build-script must be a package script name, got "${value}".`,
          };
        }
        args.buildScript = value;
      }
      continue;
    }

    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue !== undefined) {
        return { ok: false, error: `${flag} does not take a value.` };
      }
      if (flag === "--help" || flag === "-h") args.help = true;
      else if (flag === "--version") args.version = true;
      else if (flag === "--yes" || flag === "-y") args.yes = true;
      else if (flag === "--no-git") args.git = false;
      else if (flag === "--no-install") args.install = false;
      else if (flag === "--spa") args.spa = true;
      continue;
    }

    return { ok: false, error: `Unknown flag: ${flag}` };
  }

  if (args.help || args.version) {
    return { ok: true, args };
  }

  if (positionals.length > 1) {
    return {
      ok: false,
      error: `Unexpected argument "${positionals[1]}". Pass one project name.`,
    };
  }
  if (positionals.length === 1) {
    const err = validateName(positionals[0]!);
    if (err) return { ok: false, error: err };
    args.name = positionals[0]!;
  }

  const staticOnly: Array<[string, unknown]> = [
    ["--output-dir", args.outputDir],
    ["--build-script", args.buildScript],
    ["--spa", args.spa || undefined],
  ];
  for (const [flag, value] of staticOnly) {
    if (value !== undefined && args.template !== undefined && args.template !== "static") {
      return {
        ok: false,
        error: `${flag} only applies to the static template.`,
      };
    }
  }

  if (args.yes) {
    if (!args.name) {
      return { ok: false, error: `--yes requires a project name.` };
    }
    if (!args.template) {
      return { ok: false, error: `--yes requires --template (${TEMPLATES.join(", ")}).` };
    }
  }

  return { ok: true, args };
}

export const HELP_TEXT = `create-shibumi: scaffold a Shibumi Stack project

Usage
  bun create shibumi@latest [name] [flags]
  bunx create-shibumi [name] [flags]

Flags
  --template <id>       static, web, or full-stack
  --yes, -y             non-interactive; requires name and --template
  --no-git              skip git init
  --no-install          skip dependency install
  --output-dir <dir>    static only: relative build output directory
  --build-script <name> static only: package script that produces the output
  --spa                 static only: enable SPA fallback routing
  --help, -h            show this help
  --version             show version

Docs: https://shibumistack.dev/docs
`;
