import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fakeTools, humanEnv, type FakeTools } from "./fixtures/fake-tools";

const SHIP = new URL("../src/templates/ship.ts", import.meta.url).pathname;
const DOMAIN = "quiet-bamboo.dev";
const APP_ID = "quiet--bamboo-dev";
const REPOSITORY = `bitbonsai/${DOMAIN}`;
const WEBHOOK_URL = `https://${DOMAIN}/hooks/github/${APP_ID}`;

let work: string;
let project: string;
let tools: FakeTools;

function clientConfig(overrides: object = {}) {
  return {
    version: 1,
    provider: "shibumi-server",
    server: { hostname: "alpha.example.com" },
    domain: DOMAIN,
    appId: APP_ID,
    repository: `github:${REPOSITORY}`,
    branch: "main",
    webhookUrl: WEBHOOK_URL,
    service: "app",
    port: 9001,
    healthPath: "/",
    deploymentMode: "prebuilt",
    platform: "linux/arm64",
    trigger: "ship",
    cutoverRequired: false,
    ...overrides,
  };
}

const ACTIVE_HOOK = [{ id: 1, active: true, config: { url: WEBHOOK_URL }, last_response: { code: 200 } }];

function git(...args: string[]) {
  return Bun.spawnSync(["git", "-c", "user.email=t@e.st", "-c", "user.name=Test", ...args], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function setup(config: object, options: { hooks?: unknown[]; mode?: "build" | "prebuilt" } = {}) {
  work = mkdtempSync(join(tmpdir(), "shibumi-hook-"));
  project = join(work, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), `${JSON.stringify({ name: DOMAIN, private: true }, null, 2)}\n`);
  writeFileSync(join(project, "compose.yaml"), "services:\n  app:\n    build: .\n");
  writeFileSync(join(project, "shibumi-server.json"), `${JSON.stringify(config, null, 2)}\n`);
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "t@e.st");
  git("config", "user.name", "Test");
  git("add", "-A");
  git("commit", "-q", "-m", "Add Shibumi deployment");
  tools = fakeTools(work, {
    domain: DOMAIN,
    appId: APP_ID,
    repository: REPOSITORY,
    registered: true,
    hooks: options.hooks,
    mode: options.mode,
  });
}

function runWebhook(args: string[]) {
  const proc = Bun.spawnSync(["bun", SHIP, "--webhook", "--server", "alpha", "-y", ...args], {
    cwd: project,
    env: { ...humanEnv(tools.env), XDG_CONFIG_HOME: join(work, "config") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    output: proc.stdout.toString() + proc.stderr.toString(),
    calls: readFileSync(tools.log, "utf8"),
    config: JSON.parse(readFileSync(join(project, "shibumi-server.json"), "utf8")) as Record<string, unknown>,
    hooks: JSON.parse(readFileSync(join(tools.state, "hooks.json"), "utf8")) as unknown[],
  };
}

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("bun ship:webhook", () => {
  it("installs the hook and switches the trigger", () => {
    setup(clientConfig(), { mode: "prebuilt" });
    const r = runWebhook([]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("GitHub webhook created and tested");
    expect(r.output).toContain(`git push origin main now deploys. Undo: bun ship:webhook --off`);
    expect(r.calls).toContain(`"url":"${WEBHOOK_URL}"`);
    expect(r.calls).toContain("hooks/1/pings");
    // The server switched to building from the repository it now hears about.
    expect(r.calls).toContain(`deployment-mode ${APP_ID} build`);
    expect(r.config).toMatchObject({ trigger: "github-push", deploymentMode: "build" });
    expect(r.hooks).toHaveLength(1);
    // The changed config is committed, not left dirty.
    expect(git("status", "--porcelain").stdout.toString().trim()).toBe("");
  });

  it("reverses both halves with --off", () => {
    setup(clientConfig({ trigger: "github-push", deploymentMode: "build", platform: undefined }), {
      hooks: ACTIVE_HOOK,
      mode: "build",
    });
    const r = runWebhook(["--off"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("GitHub webhook disabled");
    expect(r.output).toContain("Pushes no longer deploy. Deploys run on: bun ship");
    expect(r.calls).toContain(`deployment-mode ${APP_ID} prebuilt`);
    expect(r.calls).toContain(`{"active":false}`);
    expect(r.config).toMatchObject({ trigger: "ship", deploymentMode: "prebuilt" });
    expect(r.hooks).toEqual([]);
    expect(git("status", "--porcelain").stdout.toString().trim()).toBe("");
  });

  it("still disables a live hook when the trigger was already reset", () => {
    // A hook can outlive the trigger that installed it; --off is how it goes
    // away, whatever shibumi-server.json currently claims.
    setup(clientConfig(), { hooks: ACTIVE_HOOK, mode: "prebuilt" });
    const r = runWebhook(["--off"]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("GitHub webhook disabled");
    expect(r.hooks).toEqual([]);
    expect(r.config).toMatchObject({ trigger: "ship" });
    // Nothing to change on the server: the mode already matched.
    expect(r.calls).not.toContain("deployment-mode");
  });

  it("repairs a broken hook on a project that already deploys on push", () => {
    setup(
      clientConfig({ trigger: "github-push", deploymentMode: "build", platform: undefined }),
      { hooks: [{ id: 1, active: false, config: { url: WEBHOOK_URL }, last_response: { code: 500 } }], mode: "build" }
    );
    const r = runWebhook([]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("GitHub webhook needs repair");
    expect(r.output).toContain("GitHub webhook repaired and tested");
    expect(r.config).toMatchObject({ trigger: "github-push" });
  });
});
