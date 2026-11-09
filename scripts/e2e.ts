// Opt-in deployment acceptance. Never imported by ordinary tests.
// Usage: SHIBUMI_E2E=1 bun scripts/e2e.ts prepare|local|live /absolute/target.json
// Target JSON: { directory, domain, server, repository, disposable: true }
// Use a NEW directory, an e2e-prefixed domain, and an e2e-named private GitHub repo.
// prepare packs this checkout and scaffolds outside it; local checks production
// code in a browser; live uses the shipped Ship client and real HTTPS on a VPS.
// Registration (shis add, DNS, sudo) is deliberately human-owned. No auto-delete.
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { parseTarget, assertOwnedConfig, assertOwnership, appIdForDomain } from "./e2e-target";

const root = resolve(import.meta.dir, "..");
const [mode, targetPath, ...extra] = process.argv.slice(2);
if (process.env.SHIBUMI_E2E !== "1" || !["prepare", "local", "live"].includes(mode ?? "") || !targetPath || extra.length) {
  throw new Error("Usage: SHIBUMI_E2E=1 bun scripts/e2e.ts prepare|local|live /absolute/target.json");
}
if (!isAbsolute(targetPath)) throw new Error("Target path must be absolute and outside the checkout");
const target = parseTarget(JSON.parse(await readFile(targetPath, "utf8")), root);
const app = join(target.directory, "app");
const origin = `https://${target.domain}`;
const appId = appIdForDomain(target.domain);
const report = join(target.directory, `${mode}-results.json`);
const steps: { step: string; seconds: number; ok: boolean }[] = [];
let currentStep = "preflight";
let session: string | undefined;
let sshControl: string | undefined;
let localServer: ReturnType<typeof Bun.spawn> | undefined;
let localData: string | undefined;

async function run(args: string[], cwd = app, input?: string, allowFailure = false): Promise<string> {
  const child = Bun.spawn(args, {
    cwd, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, SHIBUMI_SKIP_UPDATE_CHECK: "1", SHIBUMI_SHIP_LATEST: "1", NO_COLOR: "1" },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    // Never log stdin: it can carry test credentials or environment values.
    if (code !== 0 && !allowFailure) throw new Error(`${args[0]} exited ${code}\n${out}\n${err}`);
    if (allowFailure && code === 0) throw new Error("Deliberately unhealthy deployment unexpectedly succeeded");
    return out;
  } finally { clearTimeout(timer); }
}
async function step(name: string, fn: () => Promise<void>) {
  currentStep = name;
  console.log(`→ ${name}`);
  const start = performance.now();
  try {
    await fn();
    steps.push({ step: name, seconds: Math.round((performance.now() - start) / 1000), ok: true });
  } catch (error) {
    steps.push({ step: name, seconds: Math.round((performance.now() - start) / 1000), ok: false });
    throw error;
  }
}
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
async function ssh(args: string[], input?: string) {
  // Target grammar forbids shell syntax; every remote argument below is fixed
  // or constrained to domain/repository/SHA grammars before reaching SSH.
  return run(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ControlMaster=auto", "-o", "ControlPersist=600", "-o", "ServerAliveInterval=15", "-S", join(sshControl!, "socket"), "--", target.server, "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", "shis", ...args], app, input);
}
async function browser(args: string[], input?: string) {
  return run(["bunx", "--bun", "agent-browser@0.41.2", "--session", session!, ...args], app, input);
}
async function evaluate(source: string) { return browser(["eval", "--stdin"], source); }
async function waitFor(url: string, expected: string) {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error", cache: "no-store" });
      if (response.ok && (await response.text()).trim() === expected) return;
    } catch { /* startup and cutover can briefly make the listener unavailable */ }
    await Bun.sleep(1000);
  }
  throw new Error(`Timed out waiting for expected response: ${url}`);
}
async function commit(message: string) {
  await run(["git", "add", "-A"]);
  await run(["git", "-c", "commit.gpgsign=false", "commit", "-m", message]);
}
async function ship(expectFailure = false) {
  await run(["bun", "run", "ship", "--", "--yes", "--server", target.server], app, undefined, expectFailure);
  if (!expectFailure) await deployed((await run(["git", "rev-parse", "HEAD"])).trim());
}
async function deployed(commit: string) {
  const status = JSON.parse(await ssh(["status", appId, "--json"]));
  check(status?.commit === commit && status.state === "succeeded", "Server did not confirm the expected deployment commit");
}

// Runs inside the real browser: cookies, Origin, multipart boundaries, CSP and
// proxy behavior are not mocked. Extensions ship APIs, not auth/upload pages.
const browserSetup = `
window.e2eRequest = async (path, options = {}, status = 200) => {
  const r = await fetch(path, options);
  if (r.status !== status) throw new Error(path + ': expected ' + status + ', got ' + r.status);
  return r;
};
window.e2eJson = async (path, body, status = 200) =>
  (await e2eRequest(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}, status)).json();
`;
async function exercise(base: string, email: string, password: string) {
  await browser(["open", base]);
  await browser(["wait", "--fn", "document.querySelector('[x-data=counter] output')?.textContent !== undefined && window.Alpine !== undefined"]);
  const count = await (await fetch(`${base}/api/counter`)).json() as { count: number };
  await browser(["find", "role", "button", "click", "--name", "Count", "--exact"]);
  await browser(["wait", "--fn", `Number(document.querySelector('[x-data=counter] output').textContent) === ${count.count + 1}`]);
  await evaluate(`(async () => { ${browserSetup}
    const credentials = ${JSON.stringify({ email, password })};
    await e2eRequest('/uploads', {}, 401);
    await e2eJson('/auth/register', credentials, 201);
    const me = await (await e2eRequest('/auth/me')).json();
    if (me.user.email !== credentials.email) throw new Error('Session cookie was not accepted');
    await e2eJson('/auth/logout', {});
    const loggedOut = await (await e2eRequest('/auth/me')).json();
    if (loggedOut.user !== null) throw new Error('Logout kept the session alive');
    await e2eJson('/auth/login', {...credentials, password:'deliberately-wrong'}, 401);
    await e2eJson('/auth/login', credentials);
    const form = new FormData();
    form.set('file', new File(['%PDF-1.4\\ne2e-persistence\\n'], 'e2e.pdf', {type:'application/pdf'}));
    const upload = await (await e2eRequest('/uploads', {method:'POST', body:form}, 201)).json();
    window.e2eUploadId = upload.saved[0]?.id;
    if (!e2eUploadId) throw new Error('Upload missing');
    const download = await e2eRequest('/uploads/' + e2eUploadId);
    if (!(download.headers.get('content-disposition') || '').startsWith('attachment;')) throw new Error('Unsafe download');
    if (await download.text() !== '%PDF-1.4\\ne2e-persistence\\n') throw new Error('Upload content changed');
    return 'auth, cookies, multipart upload and download passed';
  })()`);
  // Reject a form-content-type POST with an untrusted Origin through Caddy.
  const denied = await fetch(`${base}/uploads`, {
    method: "POST", headers: { Origin: "https://attacker.invalid", "Content-Type": "application/x-www-form-urlencoded" }, body: "file=x",
  });
  check(denied.status === 403, `Cross-origin form POST returned ${denied.status}, expected 403`);
  await browser(["screenshot", join(target.directory, `${mode}-browser.png`)]);
}
async function persistence(base: string, email: string) {
  // Keep the browser document/session through deployment; no injected cookie jar.
  await evaluate(`(async () => {
    const me = await (await e2eRequest('/auth/me')).json();
    if (me.user.email !== ${JSON.stringify(email)}) throw new Error('Session lost during deploy');
    const r = await e2eRequest('/uploads/' + e2eUploadId);
    if (await r.text() !== '%PDF-1.4\\ne2e-persistence\\n') throw new Error('File lost during deploy');
    const list = await (await e2eRequest('/uploads')).json();
    if (!list.uploads.some(u => u.id === e2eUploadId)) throw new Error('Upload metadata lost');
    return 'session, database and file survived';
  })()`);
  const r = await fetch(`${base}/api/counter`);
  check(r.ok, "Counter unavailable after deployment");
  return (await r.json() as { count: number }).count;
}

try {
  check(await realpath(dirname(target.directory)) === dirname(target.directory), "Target parent must exist and must not contain symlinks");
  if (mode !== "prepare") check(await realpath(target.directory) === target.directory, "Target directory must not be a symlink");
  if (mode === "prepare") {
    await mkdir(target.directory, { recursive: false, mode: 0o700 });
    await step("pack and install CLI outside checkout", async () => {
      const tarball = join(target.directory, "create-shibumi.tgz");
      await run(["bun", "pm", "pack", "--filename", tarball], root);
      await run(["bun", "init", "-y"], target.directory);
      await run(["bun", "add", tarball], target.directory);
      await run(["bun", "node_modules/create-shibumi/src/cli.ts", "app", "--template", "full-stack", "--yes"], target.directory);
      await run(["bun", "run", "shi", "add", "auth", "--yes"]);
      await run(["bun", "run", "shi", "add", "uploads", "--yes"]);
    });
    await step("mark disposable fixture and run generated checks", async () => {
      await writeFile(join(app, "public/e2e-owner.txt"), crypto.randomUUID() + "\n");
      await writeFile(join(app, "public/e2e-version.txt"), "a\n");
      await run(["bun", "test"]);
      await run(["bun", "run", "check"]);
      await run(["bun", "run", "build"]);
      await run(["git", "checkout", "-B", "main"]);
      await commit("test: prepare disposable deployment fixture");
      await run(["git", "remote", "add", "origin", `git@github.com:${target.repository}.git`]);
    });
    console.log(`Prepared ${app}. Create the private repository and push main, then register ${target.domain} on the server before running live.`);
  } else {
    const owner = (await readFile(join(app, "public/e2e-owner.txt"), "utf8")).trim();
    check(/^[0-9a-f-]{36}$/.test(owner), "Missing disposable fixture ownership marker");
    session = `shibumi-e2e-${crypto.randomUUID()}`;
    const email = `e2e-${crypto.randomUUID()}@example.com`;
    const password = crypto.randomUUID();
    if (mode === "local") {
      const data = await mkdtemp(join(tmpdir(), "shibumi-e2e-data-"));
      localData = data;
      // ponytail: one sequential local fixture; ask the OS for an unused port.
      const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = probe.port!;
      probe.stop(true);
      const base = `http://localhost:${port}`;
      const serve = () => Bun.spawn(["bun", "dist/server.js"], {
        cwd: app, stdout: "ignore", stderr: "inherit",
        env: { ...process.env, NODE_ENV: "production", PORT: String(port), DB_PATH: join(data, "app.db"), APP_ORIGIN: base },
      });
      localServer = serve();
      await step("production-mode local browser journey", async () => {
        await waitFor(`${base}/public/e2e-owner.txt`, owner);
        await exercise(base, email, password);
      });
      await step("preserve sessions, database and files across restart", async () => {
        const count = await persistence(base, email);
        localServer!.kill();
        await localServer!.exited;
        localServer = serve();
        await waitFor(`${base}/public/e2e-owner.txt`, owner);
        check(await persistence(base, email) === count, "Counter changed across server restart");
      });
    } else {
      sshControl = await mkdtemp(join(tmpdir(), "shibumi-e2e-ssh-"));
      await step("verify dedicated registration and ownership", async () => {
        assertOwnedConfig(JSON.parse(await ssh(["client-config", appId])), target);
        const history = JSON.parse(await ssh(["history", appId, "--json"]));
        check(Array.isArray(history), "Invalid deployment history");
        let response: Response | undefined;
        try {
          response = await fetch(`${origin}/public/e2e-owner.txt`, { signal: AbortSignal.timeout(5000), redirect: "error" });
        } catch { /* A new registration may not have a certificate/listener yet. */ }
        assertOwnership(response?.status, response ? await response.text() : "", owner, history.some(entry => entry.state === "succeeded"));
        check(!(await run(["git", "status", "--porcelain"])).trim(), "Fixture has uncommitted changes");
      });
      await step("setup through generated Ship client", async () => {
        await run(["bun", "run", "ship:setup", "--", "--yes", "--server", target.server, "--domain", target.domain]);
        const config = JSON.parse(await readFile(join(app, "shibumi-server.json"), "utf8"));
        assertOwnedConfig(config, target);
        await ssh(["env", "set", appId], `APP_ORIGIN=${origin}\n`);
      });
      let commitA = "";
      await step("ship version A and exercise real HTTPS", async () => {
        if ((await readFile(join(app, "public/e2e-version.txt"), "utf8")).trim() !== "a") {
          await writeFile(join(app, "public/e2e-version.txt"), "a\n");
          await commit("test: reset to version A for acceptance rerun");
        }
        await ship();
        commitA = (await run(["git", "rev-parse", "HEAD"])).trim();
        await waitFor(`${origin}/public/e2e-version.txt`, "a");
        await waitFor(`${origin}/public/e2e-owner.txt`, owner);
        await exercise(origin, email, password);
      });
      const count = await persistence(origin, email);
      await step("repeat setup without configuration drift", async () => {
        const before = await readFile(join(app, "shibumi-server.json"), "utf8");
        await run(["bun", "run", "ship:setup", "--", "--yes", "--server", target.server, "--domain", target.domain]);
        check(await readFile(join(app, "shibumi-server.json"), "utf8") === before, "Repeated setup changed configuration");
      });
      await step("redeploy B and preserve data", async () => {
        await writeFile(join(app, "public/e2e-version.txt"), "b\n");
        await commit("test: deploy version B");
        await ship();
        await waitFor(`${origin}/public/e2e-version.txt`, "b");
        check(await persistence(origin, email) === count, "Counter data changed across redeploy");
      });
      await step("reject unhealthy deployment and recover B", async () => {
        const path = join(app, "src/app.ts");
        const source = await readFile(path, "utf8");
        const healthy = 'app.get("/healthz", (c) => c.json({ ok: true }));';
        check(source.includes(healthy), "Health route contract changed; update the failure fixture");
        // Keep source-mode checks green; the built production container must
        // fail its real health check, not merely trip Ship's local tests.
        await writeFile(path, source.replace(healthy, 'app.get("/healthz", (c) => process.env["NODE_ENV"] === "production" ? c.json({ ok: false }, 503) : c.json({ ok: true }));'));
        await commit("test: deliberately unhealthy version C");
        const failedCommit = (await run(["git", "rev-parse", "HEAD"])).trim();
        try {
          await ship(true);
          const status = JSON.parse(await ssh(["status", appId, "--commit", failedCommit, "--json"]));
          check(status?.commit === failedCommit && status.state === "failed" && status.stage === "health", "Expected a server-side health failure for version C, not an unrelated CLI failure");
          await waitFor(`${origin}/public/e2e-version.txt`, "b");
          check(await persistence(origin, email) === count, "Data changed after failed deployment");
        } finally {
          await writeFile(path, source);
          await commit("test: restore healthy source after failure probe");
          await run(["git", "push", "origin", "main"]);
        }
      });
      await step("rollback to A with persistent data", async () => {
        await run(["bun", "run", "ship", "--", "--rollback", "--yes", "--server", target.server]);
        await deployed(commitA);
        await waitFor(`${origin}/public/e2e-version.txt`, "a");
        check(await persistence(origin, email) === count, "Data changed across rollback");
      });
      console.log("Live journey passed. Test registration and private repo retained for inspection; no production apps touched.");
    }
  }
} catch (error) {
  console.error(`FAILED: ${currentStep}\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
  if (mode === "live" && await Bun.file(join(app, "shibumi-server.json")).exists()) {
    for (const command of ["status", "history"]) {
      const output = await ssh([command, appId, "--json"]).catch(() => "Diagnostics unavailable\n");
      await writeFile(join(target.directory, `${command}-failure.json`), output, { mode: 0o600 });
    }
  }
} finally {
  if (sshControl) {
    await run(["ssh", "-S", join(sshControl, "socket"), "-O", "exit", "--", target.server]).catch(() => {});
    await rm(sshControl, { recursive: true, force: true });
  }
  if (localServer) { localServer.kill(); await localServer.exited; }
  if (localData) await rm(localData, { recursive: true, force: true });
  if (session) {
    if (process.exitCode) await browser(["screenshot", join(target.directory, `${mode}-failure.png`)]).catch(() => {});
    await browser(["close"]).catch(() => {});
  }
  if (await Bun.file(join(app, "public/e2e-owner.txt")).exists()) {
    await writeFile(report, JSON.stringify({ mode, steps, passed: !process.exitCode }, null, 2) + "\n", { mode: 0o600 });
    console.log(`Results: ${report}`);
  }
}
