import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fakeTools, humanEnv, ptyCommand, type FakeTools } from "./fixtures/fake-tools";

const SHIP = new URL("../src/templates/ship.ts", import.meta.url).pathname;
if (!Bun.which("python3")) throw new Error("these tests need python3 to allocate a pty");
const DOMAIN = "quiet-bamboo.dev";
const APP_ID = "quiet--bamboo-dev";
const REPOSITORY = `bitbonsai/${DOMAIN}`;

let work: string;
let project: string;
let tools: FakeTools;

function git(...args: string[]) {
  return Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=Test", ...args], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function commits(): string[] {
  const log = git("log", "--oneline");
  return log.exitCode === 0 ? log.stdout.toString().trim().split("\n").filter(Boolean) : [];
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "shibumi-plan-"));
  project = join(work, "project");
  mkdirSync(join(project, "public"), { recursive: true });
  // A build script keeps the committed-output rule out of the way; the point
  // of these fixtures is the plan, not static verification.
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: DOMAIN, private: true, scripts: { build: "true" } }, null, 2)}\n`
  );
  writeFileSync(join(project, "public", "index.html"), "<!doctype html>\n");
  // None of these are gitignored, on purpose. The two real dotenv files must
  // stay out of the commit setup then pushes; the example and the two source
  // files whose names merely contain ".env" must go in.
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, ".env"), "API_TOKEN=super-secret\n");
  writeFileSync(join(project, ".env.local"), "API_TOKEN=also-secret\n");
  writeFileSync(join(project, ".env.example"), "API_TOKEN=\n");
  writeFileSync(join(project, ".env.sample"), "API_TOKEN=\n");
  writeFileSync(join(project, ".env.template"), "API_TOKEN=\n");
  writeFileSync(join(project, "src", "schema.env.ts"), "export type Env = { API_TOKEN: string };\n");
  writeFileSync(join(project, "src", "config.env.json"), `{ "region": "eu" }\n`);
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "t@e.st");
  git("config", "user.name", "Test");
  tools = fakeTools(work, { domain: DOMAIN, appId: APP_ID, repository: REPOSITORY });
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

// A pty plus a scrubbed environment is what makes the client believe it is
// talking to a person, which is the only way the plan path runs at all.
function runSetup(args: string[], keys: string[], options: { unauthenticated?: boolean } = {}) {
  const proc = Bun.spawnSync(ptyCommand(["bun", SHIP, "--setup", ...args]), {
    cwd: project,
    env: {
      ...humanEnv(tools.env),
      XDG_CONFIG_HOME: join(work, "config"),
      PTY_KEYS: JSON.stringify(keys),
      ...(options.unauthenticated ? { SHIBUMI_FAKE_GH_UNAUTH: "1" } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  // The pty merges both streams and adds carriage returns.
  const output = (proc.stdout.toString() + proc.stderr.toString())
    .replaceAll("\r\n", "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  return { code: proc.exitCode, output };
}

function calls(): string {
  return readFileSync(tools.log, "utf8");
}

const STATIC_ARGS = ["--static", "--output-dir", "public", "--no-spa", "--server", "alpha"];

describe("setup plan", () => {
  it("renders the plan before it changes anything, and cancelling changes nothing", () => {
    // "n" answers the one confirm the plan gates everything behind.
    const r = runSetup(STATIC_ARGS, ["n"]);
    expect(r.output).toContain("Plan");
    expect(r.output).toContain("Generate deployment files (static, public/, bun run build)");
    expect(r.output).toContain(`Create private repo ${REPOSITORY}, push main`);
    expect(r.output).toContain("Connect to alpha, save target for this project");
    expect(r.output).toContain("Install or upgrade shibumi-server (sudo password once)");
    expect(r.output).toContain(`Register ${DOMAIN}`);
    expect(r.output).toContain("Commit and push deployment files");
    expect(r.output).toContain("Deploys run on: bun ship");
    expect(r.output).toContain("Run setup?");
    expect(r.output).toContain("Setup cancelled. Nothing was changed.");

    // Nothing generated, nothing committed, no repository, no registration.
    for (const file of ["Dockerfile", "compose.yaml", ".dockerignore", "shibumi-server.json"]) {
      expect(existsSync(join(project, file))).toBe(false);
    }
    expect(commits()).toEqual([]);
    expect(git("remote").stdout.toString().trim()).toBe("");
    expect(calls()).not.toContain("repo create");
    expect(calls()).not.toContain("shibumi-server add");
  });

  it("runs every planned step on one confirm and leaves .env out of the commit", () => {
    // Enter accepts "Run setup?"; "n" declines "Ship now?" at the end.
    const r = runSetup(STATIC_ARGS, ["\r", "n"]);
    expect(r.output).toContain("Run setup?");
    // Not one of the planned steps: gh is already authenticated here, and the
    // plan confirm must never stand in for a browser sign-in.
    expect(r.output).not.toContain("Sign in to GitHub now?");
    expect(calls()).not.toContain("gh auth login");

    expect(r.output).toContain("Generated Dockerfile, compose.yaml, .dockerignore");
    expect(r.output).toContain("Committed: Initial commit");
    expect(r.output).toContain(`Created private repo ${REPOSITORY} and pushed main`);
    expect(r.output).toContain(`Found ${DOMAIN} on alpha.example.com`);
    expect(r.output).toContain("Wrote shibumi-server.json");
    expect(r.output).toContain("Deployments run through bun ship");
    expect(r.output).toContain("Pushed main to origin");
    expect(r.output).toContain("Ship now?");
    // The trigger question is gone: the plan states the trigger instead.
    expect(r.output).not.toContain("How do you want to deploy?");

    // Exactly the two real dotenv files stayed local. A wider pathspec drops
    // .env.example and any src file whose name contains ".env", which on a
    // first commit means pushing an incomplete tree.
    const tracked = git("ls-files").stdout.toString().split("\n").filter(Boolean);
    expect(tracked).not.toContain(".env");
    expect(tracked).not.toContain(".env.local");
    expect(tracked).toContain(".env.example");
    expect(tracked).toContain(".env.sample");
    expect(tracked).toContain(".env.template");
    expect(tracked).toContain("src/schema.env.ts");
    expect(tracked).toContain("src/config.env.json");
    expect(tracked).toContain("compose.yaml");
    expect(tracked).toContain("shibumi-server.json");
    // And the warning names the two it held back, and only those: git's own
    // commit output lists the example files, so read the warning line itself.
    expect(/Left (.+) out of the commit/.exec(r.output)?.[1]).toBe(".env, .env.local");
    expect(readFileSync(join(project, ".env"), "utf8")).toContain("super-secret");

    // The push really happened: the bare origin has the branch.
    const remote = Bun.spawnSync(["git", "--git-dir", tools.origin, "log", "--oneline", "main"]);
    expect(remote.exitCode).toBe(0);
    expect(remote.stdout.toString()).toContain("Add Shibumi deployment");

    const config = JSON.parse(readFileSync(join(project, "shibumi-server.json"), "utf8"));
    expect(config).toMatchObject({ domain: DOMAIN, appId: APP_ID, repository: `github:${REPOSITORY}`, trigger: "ship" });
    // Default setup installs no webhook.
    expect(calls()).not.toContain("hooks");
    expect(calls()).toContain("repo create");
    expect(calls()).toContain("--private");
    expect(calls()).not.toContain("--public");
  });

  it("creates a public repository only when asked", () => {
    const r = runSetup([...STATIC_ARGS, "--public"], ["\r", "n"]);
    expect(r.output).toContain(`Create public repo ${REPOSITORY}, push main`);
    expect(calls()).toContain("--public");
    expect(calls()).not.toContain("--private");
  });

  it("renders the plan under --yes too, with nothing to confirm", () => {
    // A transcript that never says what it did is not a receipt. --yes skips
    // the confirm, not the plan.
    writeFileSync(join(project, "compose.yaml"), "services:\n  app:\n    build: .\n");
    git("add", "-A");
    git("commit", "-q", "-m", "Add deployment configuration");
    git("remote", "add", "origin", `https://github.com/${REPOSITORY}.git`);
    git("remote", "set-url", "--push", "origin", `file://${tools.origin}`);
    // Registering a new app needs interactive SSH and sudo, which a
    // non-interactive run refuses; this one re-uses an existing registration.
    writeFileSync(join(tools.state, "registered"), "");
    const proc = Bun.spawnSync(["bun", SHIP, "--setup", "-y", "--server", "alpha"], {
      cwd: project,
      env: { ...humanEnv(tools.env), XDG_CONFIG_HOME: join(work, "config") },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = proc.stdout.toString() + proc.stderr.toString();
    expect(proc.exitCode).toBe(0);
    expect(output).toContain("Plan");
    expect(output).toContain("Connect to alpha, save target for this project");
    expect(output).toContain(`Register ${DOMAIN}`);
    expect(output).toContain("Deploys run on: bun ship");
    expect(output).not.toContain("Run setup?");
    // An existing origin is left alone, and the plan says so.
    expect(output).not.toContain("Create private repo");
    expect(calls()).not.toContain("repo create");
    expect(readFileSync(join(project, "shibumi-server.json"), "utf8")).toContain(APP_ID);
    expect(output).toContain("Pushed main to origin");
  });

  it("restores the per-step gates with --interactive, and asks each one once", () => {
    // A project with history and an origin: the steps left to gate are the
    // generated-files commit, the SSH registration, and the setup commit.
    git("add", "-A");
    git("commit", "-q", "-m", "Initial commit");
    git("remote", "add", "origin", `https://github.com/${REPOSITORY}.git`);
    git("remote", "set-url", "--push", "origin", `file://${tools.origin}`);
    const r = runSetup([...STATIC_ARGS, "--interactive"], ["\r", "\r", "\r", "n"]);
    expect(r.output).toContain("Plan");
    expect(r.output).not.toContain("Run setup?");
    expect(r.output).toContain("Commit the generated files, then continue setup?");
    expect(r.output).toContain("Continue through SSH?");
    expect(r.output).toContain("Commit deployment setup now?");
    // Once, not twice: setup and runShip used to both ask, and declining the
    // first then committed without pushing on the second.
    expect(r.output.split("◇  Commit deployment setup now?")).toHaveLength(2);
    expect(readFileSync(join(project, "shibumi-server.json"), "utf8")).toContain(APP_ID);
    expect(git("status", "--porcelain").stdout.toString().trim()).toBe("");
  });

  it("still asks for a GitHub sign-in the plan never promised", () => {
    // Only the plan confirm is answered. An unauthenticated gh has to stop the
    // run at its own prompt rather than launch a browser on the plan's behalf.
    const r = runSetup(STATIC_ARGS, ["\r", "\x1b"], { unauthenticated: true });
    expect(r.output).toContain("Sign in to GitHub now?");
    expect(r.output).toContain("Next: run gh auth login -h github.com -p https -w");
    expect(calls()).not.toContain("gh auth login");
    expect(calls()).not.toContain("repo create");
    expect(existsSync(join(project, "shibumi-server.json"))).toBe(false);
  });
});
