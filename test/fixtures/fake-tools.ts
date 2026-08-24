// Stand-ins for the two commands the Ship client talks to the outside world
// with: `gh` and `ssh`. Both log every invocation so a test can assert what
// was and was not run (a webhook PATCH, an unasked-for `gh auth login`), and
// both keep state in files so a run can register an app, flip a deployment
// mode, or install a webhook and see it on the next call.
//
// The fake origin is a local bare repository wired in as the remote's push
// URL, so `git remote get-url origin` still answers with a github.com URL
// (the client refuses anything else) while pushes stay on this machine.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SECRET = "a".repeat(64);

export interface FakeTools {
  bin: string;
  state: string;
  log: string;
  origin: string;
  env: Record<string, string>;
}

const GH = `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$SHIBUMI_FAKE_LOG"
case "$1 $2" in
  "auth status")
    [ -n "$SHIBUMI_FAKE_GH_UNAUTH" ] && { echo "not logged in" >&2; exit 1; }
    exit 0 ;;
  "auth login") echo "fake gh must never be asked to log in" >&2; exit 1 ;;
  "auth refresh") exit 0 ;;
esac
if [ "$1 $2" = "repo create" ]; then
  # The fetch URL stays a github.com URL (the client refuses anything else);
  # only the push URL points at the local bare repository.
  git remote add origin "$SHIBUMI_FAKE_REPO_URL" || exit 1
  git remote set-url --push origin "file://$SHIBUMI_FAKE_ORIGIN" || exit 1
  git push -q -u origin HEAD || exit 1
  exit 0
fi
if [ "$1" = "api" ]; then
  shift
  method=GET
  while [ "$1" = "-X" ] || [ "$1" = "--input" ] || [ "$1" = "--jq" ]; do
    case "$1" in
      -X) method="$2" ;;
      --input) input="$2" ;;
      --jq) jq="$2" ;;
    esac
    shift 2
  done
  endpoint="$1"
  [ "$method" != GET ] && [ -z "$input" ] && input="-"
  [ "$input" = "-" ] && cat >> "$SHIBUMI_FAKE_LOG"
  case "$endpoint" in
    user) echo "$SHIBUMI_FAKE_OWNER" ;;
    */protection) echo '{}' ;;
    *hooks\\?per_page=100) cat "$SHIBUMI_FAKE_STATE/hooks.json" ;;
    */hooks)
      printf '[{"id":1,"active":true,"config":{"url":"%s"},"last_response":{"code":200}}]\\n' \\
        "$SHIBUMI_FAKE_WEBHOOK_URL" > "$SHIBUMI_FAKE_STATE/hooks.json"
      echo '{"id":1}' ;;
    */hooks/1/pings) exit 0 ;;
    */hooks/1/config) echo '{}' ;;
    */hooks/1)
      if [ "$method" = PATCH ]; then
        echo '[]' > "$SHIBUMI_FAKE_STATE/hooks.json"
        echo '{}'
      else
        printf '{"id":1,"active":true,"last_response":{"code":200}}\\n'
      fi ;;
    *) echo "unexpected gh api endpoint: $endpoint" >&2; exit 1 ;;
  esac
  exit 0
fi
echo "unexpected gh call: $*" >&2
exit 1
`;

const SSH = `#!/bin/sh
printf 'ssh %s\\n' "$*" >> "$SHIBUMI_FAKE_LOG"
for arg in "$@"; do
  [ "$arg" = "-G" ] && { echo "hostname $SHIBUMI_FAKE_HOSTNAME"; exit 0; }
  [ "$arg" = "-O" ] && exit 0
done
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; shift; break; fi
  shift
done
while [ $# -gt 0 ]; do
  case "$1" in
    env|*=*|*shibumi-server) shift ;;
    *) break ;;
  esac
done
sub="$1"
[ $# -gt 0 ] && shift
config() {
  mode=prebuilt
  [ -f "$SHIBUMI_FAKE_STATE/mode" ] && mode="$(cat "$SHIBUMI_FAKE_STATE/mode")"
  printf '{"version":1,"provider":"shibumi-server","server":{"hostname":"%s"},"domain":"%s","appId":"%s","repository":"github:%s","branch":"%s","webhookUrl":"%s","service":"app","port":9001,"healthPath":"/","deploymentMode":"%s","platform":"linux/arm64","cutoverRequired":false}\\n' \\
    "$SHIBUMI_FAKE_HOSTNAME" "$SHIBUMI_FAKE_DOMAIN" "$SHIBUMI_FAKE_APP_ID" "$SHIBUMI_FAKE_REPO" \\
    "$SHIBUMI_FAKE_BRANCH" "$SHIBUMI_FAKE_WEBHOOK_URL" "$mode"
}
case "$sub" in
  --version) echo "$SHIBUMI_FAKE_SERVER_VERSION" ;;
  client-config)
    [ -f "$SHIBUMI_FAKE_STATE/registered" ] || { echo "app is not registered" >&2; exit 1; }
    config ;;
  add) : > "$SHIBUMI_FAKE_STATE/registered" ;;
  deployment-mode) printf '%s' "$2" > "$SHIBUMI_FAKE_STATE/mode" ;;
  webhook-secret) printf '{"secret":"%s"}\\n' "$SHIBUMI_FAKE_SECRET" ;;
  *) echo "unexpected remote command: $sub" >&2; exit 1 ;;
esac
exit 0
`;

export function fakeTools(work: string, options: {
  domain: string;
  appId: string;
  repository: string;
  branch?: string;
  owner?: string;
  registered?: boolean;
  hooks?: unknown[];
  mode?: "build" | "prebuilt";
} ): FakeTools {
  const bin = join(work, "fake-bin");
  const state = join(work, "fake-state");
  const origin = join(work, "origin.git");
  const log = join(state, "calls.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  for (const [name, source] of [["gh", GH], ["ssh", SSH]] as const) {
    const path = join(bin, name);
    writeFileSync(path, source);
    chmodSync(path, 0o755);
  }
  writeFileSync(log, "");
  writeFileSync(join(state, "hooks.json"), `${JSON.stringify(options.hooks ?? [])}\n`);
  if (options.registered) writeFileSync(join(state, "registered"), "");
  if (options.mode) writeFileSync(join(state, "mode"), options.mode);
  Bun.spawnSync(["git", "init", "-q", "--bare", origin]);

  const branch = options.branch ?? "main";
  const repoUrl = `https://github.com/${options.repository}.git`;
  return {
    bin,
    state,
    log,
    origin,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SHIBUMI_FAKE_LOG: log,
      SHIBUMI_FAKE_STATE: state,
      SHIBUMI_FAKE_ORIGIN: origin,
      SHIBUMI_FAKE_REPO: options.repository,
      SHIBUMI_FAKE_REPO_URL: repoUrl,
      SHIBUMI_FAKE_OWNER: options.owner ?? "bitbonsai",
      SHIBUMI_FAKE_DOMAIN: options.domain,
      SHIBUMI_FAKE_APP_ID: options.appId,
      SHIBUMI_FAKE_BRANCH: branch,
      SHIBUMI_FAKE_HOSTNAME: "alpha.example.com",
      SHIBUMI_FAKE_SERVER_VERSION: "0.10.6",
      SHIBUMI_FAKE_SECRET: SECRET,
      SHIBUMI_FAKE_WEBHOOK_URL: `https://${options.domain}/hooks/github/${options.appId}`,
    },
  };
}

// Env for running the client as a person at a terminal: the agent-detection
// variables of whatever shell launched the tests must not leak in, or the
// client takes its non-interactive path and the plan never renders.
export function humanEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(?:CODEX_|CURSOR_AGENT|AIDER_)/.test(key)) delete env[key];
  }
  delete env.CLAUDECODE;
  delete env.PI_CODING_AGENT;
  delete env.CI;
  return env;
}

// A pty, so the client sees a terminal and renders the plan. `script` cannot
// do it here (it needs its own stdin to be a terminal), so a small python
// runner owns the pty and feeds keystrokes in.
export function ptyCommand(command: string[]): string[] {
  return ["python3", join(import.meta.dir, "pty-run.py"), ...command];
}
