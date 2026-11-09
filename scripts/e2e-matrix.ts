// Opt-in: two live journeys for EVERY template in src/args.ts.
// SHIBUMI_E2E=1 bun scripts/e2e-matrix.ts /absolute/target.json
// Reuses ONE disposable registration/repo sequentially; restores full-stack
// source and deploys it in finally. No DNS, sudo, app removal or history resets.
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { TEMPLATES, type TemplateId } from "../src/args";
import { appIdForDomain, assertOwnedConfig, assertOwnership, parseTarget } from "./e2e-target";

const root = resolve(import.meta.dir, "..");
const [targetPath, ...extra] = process.argv.slice(2);
if (process.env.SHIBUMI_E2E !== "1" || !targetPath || !isAbsolute(targetPath) || extra.length) {
  throw new Error("Usage: SHIBUMI_E2E=1 bun scripts/e2e-matrix.ts /absolute/target.json");
}
const target = parseTarget(JSON.parse(await readFile(targetPath, "utf8")), root);
const app = join(target.directory, "app");
const origin = `https://${target.domain}`;
const appId = appIdForDomain(target.domain);
if (await realpath(target.directory) !== target.directory || await realpath(app) !== app) throw new Error("Fixture paths must not contain symlinks");
const lock = join(target.directory, "matrix.lock");
await mkdir(lock, { mode: 0o700 }); // Exclusive: never run two destructive fixture swaps together.
const artifacts = await mkdtemp(join(target.directory, "matrix-"));
const control = await mkdtemp(join(tmpdir(), "shibumi-matrix-ssh-"));
const results: { template: TemplateId; round: number; passed: boolean; commit?: string; steps: string[] }[] = [];
let snapshot: string | undefined;
let owner = "";
let session: string | undefined;
let restored = false;
let startedReplacing = false;
let initialCount = 0;
let log = join(artifacts, "preflight.log");
const startedAt = new Date().toISOString();

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function run(args: string[], cwd = app, input?: string, expectFailure = false): Promise<string> {
  const child = Bun.spawn(args, {
    cwd, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, SHIBUMI_E2E: "1", SHIBUMI_SKIP_UPDATE_CHECK: "1", SHIBUMI_SHIP_LATEST: "1", NO_COLOR: "1" },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15 * 60_000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await writeFile(log, `$ ${args.join(" ")}\n${out}${err}\n`, { flag: "a", mode: 0o600 });
    if (expectFailure ? code === 0 : code !== 0) throw new Error(`${args[0]} exited ${code}; see ${log}`);
    return out;
  } finally { clearTimeout(timer); }
}
async function ssh(args: string[]) {
  return run(["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ControlMaster=auto", "-o", "ControlPersist=600", "-o", "ServerAliveInterval=15", "-S", join(control, "socket"), "--", target.server, "env", "SHIBUMI_SKIP_UPDATE_CHECK=1", "shis", ...args]);
}
async function browser(args: string[], input?: string) {
  return run(["bunx", "--bun", "agent-browser@0.41.2", "--session", session!, ...args], app, input);
}
async function evaluate(source: string) { return browser(["eval", "--stdin"], source); }
async function commit(message: string) {
  await run(["git", "add", "-A"]);
  await run(["git", "-c", "commit.gpgsign=false", "commit", "-m", message]);
  return (await run(["git", "rev-parse", "HEAD"])).trim();
}
async function ship(expectFailure = false) {
  await run(["bun", "run", "ship", "--", "--yes", "--server", target.server], app, undefined, expectFailure);
  const commit = (await run(["git", "rev-parse", "HEAD"])).trim();
  const status = JSON.parse(await ssh(["status", appId, "--commit", commit, "--json"]));
  check(status?.commit === commit && status.state === (expectFailure ? "failed" : "succeeded"), "Server did not confirm the expected commit/state");
  if (expectFailure) check(status.stage === "health", "Unhealthy probe failed before the server health check");
  return commit;
}
async function setupSite(template: "blog" | "static") {
  const command = ["bun", "run", "ship:setup", "--", "--yes", "--server", target.server, "--domain", target.domain];
  await run(command);
  if (!(await Bun.file(join(app, "shibumi-server.json")).exists())) {
    // Ship deliberately pauses agent runs for review of newly generated files.
    const changed = (await run(["git", "status", "--porcelain"])).trim().split("\n").map(line => line.slice(3)).sort();
    check(JSON.stringify(changed) === JSON.stringify([".dockerignore", "Dockerfile", "compose.yaml"]), "Unexpected setup changes at the generated-files review gate");
    const compose = await readFile(join(app, "compose.yaml"), "utf8");
    check(compose.includes(`dev.shibumistack.static.output: "${template === "blog" ? "dist" : "public"}"`) && compose.includes("  app:"), "Generated Compose does not match the requested static output/service");
    check((await readFile(join(app, "Dockerfile"), "utf8")).includes("FROM scratch"), "Expected the generated non-SPA static image");
    await commit(`test: review generated ${template} deployment files`);
    await run(["git", "push", "origin", "main"]);
    await run(command);
  }
  assertOwnedConfig(JSON.parse(await readFile(join(app, "shibumi-server.json"), "utf8")), target);
}
async function get(path: string, status = 200) {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(15_000), redirect: "follow", cache: "no-store" });
  check(response.status === status, `${path}: expected HTTP ${status}, got ${response.status}`);
  return response;
}
async function version(expected: string) {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    try { if ((await (await get("/e2e-version.txt")).text()).trim() === expected) return; } catch { /* cutover */ }
    await Bun.sleep(1000);
  }
  throw new Error(`Version ${expected} did not become live`);
}
async function clean() {
  check((await run(["git", "rev-parse", "--show-toplevel"])).trim() === app, "Refusing a non-fixture Git directory");
  check((await run(["git", "show", "HEAD:public/e2e-owner.txt"])).trim() === owner, "Fixture ownership changed");
  check(!(await run(["git", "status", "--porcelain"])).trim(), "Refusing to replace uncommitted work");
}
async function clearFixture(restoring = false) {
  // Only this explicitly disposable, ownership-checked checkout is replaced.
  // Keep .git and its linear history; never reset, force-push or remove volumes.
  if (!restoring) await clean();
  else {
    check((await run(["git", "rev-parse", "--show-toplevel"])).trim() === app, "Fixture Git directory changed before restore");
    check((await run(["git", "show", "HEAD:public/e2e-owner.txt"])).trim() === owner, "Fixture ownership changed before restore");
  }
  for (const name of await readdir(app)) if (name !== ".git") await rm(join(app, name), { recursive: true, force: true });
}
async function install(template: TemplateId, round: number) {
  const name = `${template}-${round}`;
  await run(["bun", "node_modules/create-shibumi/src/cli.ts", name, "--template", template, "--yes", "--no-git"], artifacts);
  const fixture = join(artifacts, name);
  if (template === "full-stack") {
    await run(["bun", "run", "shi", "add", "auth", "--yes"], fixture);
    await run(["bun", "run", "shi", "add", "uploads", "--yes"], fixture);
  }
  await writeFile(join(fixture, "public/e2e-owner.txt"), owner + "\n");
  await writeFile(join(fixture, "public/e2e-version.txt"), "a\n");
  await clean();
  startedReplacing = true;
  await clearFixture();
  // CLI --no-git guarantees no nested .git overwrites this fixture repository.
  for (const name of await readdir(fixture)) {
    check(name !== ".git", "Scaffolder unexpectedly created .git");
    if (name !== "node_modules") await cp(join(fixture, name), join(app, name), { recursive: true });
  }
  await run(["bun", "install", "--frozen-lockfile"]);
  if (template !== "full-stack") {
    // Test content only. A stable /healthz lets all templates reuse the
    // existing registration, whose real health endpoint is /healthz.
    await mkdir(join(app, "public/public"), { recursive: true });
    await writeFile(join(app, "public/public/e2e-owner.txt"), owner + "\n");
    await writeFile(join(app, "public/healthz"), "ok\n");
    await writeFile(join(app, "public/e2e-template.txt"), template + "\n");
    if (template === "blog") {
      const site = join(app, "src/site.ts");
      await writeFile(site, (await readFile(site, "utf8")).replace('url: "https://example.com"', `url: ${JSON.stringify(origin)}`));
      await writeFile(join(app, "src/content/blog/e2e-draft.md"), "---\ntitle: E2E draft\ndescription: This draft must never appear in the public site, RSS feed or sitemap.\ndate: 2026-01-01\ndraft: true\n---\n\nPrivate draft sentinel.\n");
    } else {
      await mkdir(join(app, "public/guide"), { recursive: true });
      await writeFile(join(app, "public/guide/index.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><title>E2E guide</title><h1>E2E guide</h1><a href="/">Home</a></html>');
      const path = join(app, "public/index.html");
      await writeFile(path, (await readFile(path, "utf8")).replace("</main>", '<p id="e2e-release"></p><a href="/guide/">E2E guide</a></main>'));
    }
    await release(template, "a");
  }
  await commit(`test: scaffold ${template} journey ${round}`);
}
async function release(template: "blog" | "static", value: string) {
  await writeFile(join(app, "public/e2e-version.txt"), value + "\n");
  if (template === "blog") {
    await writeFile(join(app, "src/content/blog/e2e-contract.md"), `---\ntitle: E2E contract\ndescription: A generated blog post used to verify real rendering, deployment, feeds and rollback.\ndate: 2026-01-01\n---\n\nE2E release ${value.toUpperCase()}.\n\n## Owned content\n\n**Markdown works.**\n\n[Read the source](/posts/e2e-contract.md)\n`);
  } else {
    const path = join(app, "public/index.html");
    await writeFile(path, (await readFile(path, "utf8")).replace(/<p id="e2e-release">.*?<\/p>/, `<p id="e2e-release">E2E release ${value.toUpperCase()}.</p>`));
  }
}
async function checkSite(template: "blog" | "static", value: string, screenshot: string) {
  check((await (await get("/e2e-template.txt")).text()).trim() === template, "Wrong template is running");
  const home = await get("/");
  check(home.headers.get("content-type")?.includes("text/html"), "Homepage MIME type");
  const html = await home.text();
  let contentEtag = home.headers.get("etag");
  check(!/\{\{[a-z-]+\}\}/i.test(html), "Unresolved template tokens in built HTML");
  const css = await get("/style.css");
  check(css.headers.get("content-type")?.includes("text/css"), "Stylesheet MIME type");
  await get("/favicon.svg");
  await get("/this-page-must-not-exist", 404);
  const head = await fetch(origin + "/", { method: "HEAD", signal: AbortSignal.timeout(15_000) });
  check(head.status === 200 && (await head.text()) === "", "HEAD must return no response body");
  const post = await fetch(origin + "/style.css", { method: "POST", signal: AbortSignal.timeout(15_000) });
  check(post.status >= 400, "Static server unexpectedly accepted a mutation");
  await browser(["open", origin]);
  await evaluate(`JSON.stringify({navigation: performance.getEntriesByType('navigation').map(n => ({type:n.type, transferSize:n.transferSize})), visibleRelease:document.body.innerText.match(/E2E release [ABC]\\./)?.[0] ?? null})`);
  // A normal navigation may reuse fresh cached HTML. Test a user's standard
  // reload (conditional revalidation), not a cache wipe or cache-busting URL.
  await browser(["reload"]);
  if (template === "blog") {
    check(!html.includes("E2E draft"), "Draft leaked into homepage");
    await browser(["find", "role", "link", "click", "--name", "E2E contract"]);
    await browser(["wait", "--url", "**/posts/e2e-contract/"]);
    await browser(["wait", "--load", "networkidle"]);
    await browser(["reload"]);
    await browser(["wait", "--text", `E2E release ${value.toUpperCase()}.`]);
    const article = await get("/posts/e2e-contract/");
    contentEtag = article.headers.get("etag");
    check((await article.text()).includes(`E2E release ${value.toUpperCase()}.`), "Post HTML did not match deployed content");
    await evaluate(`(async () => {
      const canonical = document.querySelector('link[rel=canonical]')?.href;
      if (canonical !== ${JSON.stringify(origin + "/posts/e2e-contract/")}) throw new Error('Canonical URL mismatch: ' + canonical);
      if (!document.querySelector('meta[property="og:image"]')?.content.startsWith(location.origin)) throw new Error('Missing local OG image');
      for (const path of ['/rss.xml', '/sitemap.xml']) {
        const r = await fetch(path); const text = await r.text();
        const xml = new DOMParser().parseFromString(text, 'application/xml');
        if (!r.ok || xml.querySelector('parsererror') || !text.includes(location.origin + '/posts/e2e-contract') || text.includes('e2e-draft')) throw new Error(path + ' invalid');
      }
      return 'canonical, OG metadata, RSS and sitemap passed';
    })()`);
    const markdown = await get("/posts/e2e-contract.md");
    check(markdown.headers.get("content-type")?.includes("text/plain"), "Markdown alternate MIME type");
    check((await markdown.text()).includes(`E2E release ${value.toUpperCase()}.`), "Markdown alternate content");
    check((await (await get("/llms.txt")).text()).includes(origin + "/posts/e2e-contract.md"), "llms.txt missing Markdown link");
    check((await (await get("/robots.txt")).text()).includes(origin + "/sitemap.xml"), "robots.txt sitemap URL");
    await get("/posts/e2e-draft/", 404);
    await get("/posts/e2e-draft.md", 404);
    await get("/og-default.png");
  } else {
    await browser(["wait", "--text", `E2E release ${value.toUpperCase()}.`]);
    await browser(["find", "role", "link", "click", "--name", "E2E guide", "--exact"]);
    await browser(["wait", "--url", "**/guide/"]);
    await browser(["find", "role", "link", "click", "--name", "Home", "--exact"]);
    await browser(["wait", "--text", `E2E release ${value.toUpperCase()}.`]);
    const missing = await get("/this-page-must-not-exist", 404);
    check((await missing.text()).includes("Not found"), "Custom 404 page missing");
  }
  await browser(["screenshot", screenshot]);
  return contentEtag;
}

try {
  owner = (await readFile(join(app, "public/e2e-owner.txt"), "utf8")).trim();
  check(/^[0-9a-f-]{36}$/.test(owner), "Missing fixture ownership marker");
  await clean();
  check((await run(["git", "branch", "--show-current"])).trim() === "main", "Fixture must be on main");
  const remote = (await run(["git", "remote", "get-url", "origin"])).trim();
  check([`git@github.com:${target.repository}.git`, `https://github.com/${target.repository}.git`].includes(remote), "Fixture repository does not match target");
  const config = JSON.parse(await ssh(["client-config", appId]));
  assertOwnedConfig(config, target);
  check(config.healthPath === "/healthz" && config.deploymentMode === "prebuilt", "Matrix requires the full-stack prebuilt test registration");
  const remoteOwner = await get("/public/e2e-owner.txt");
  assertOwnership(remoteOwner.status, await remoteOwner.text(), owner, true);
  initialCount = (await (await get("/api/counter")).json() as { count: number }).count;
  snapshot = (await run(["git", "rev-parse", "HEAD"])).trim();
  await run(["git", "archive", "--format=tar", "--output", join(artifacts, "original.tar"), snapshot]);
  await run(["bun", "pm", "pack", "--filename", join(artifacts, "create-shibumi.tgz")], root);
  await run(["bun", "init", "-y"], artifacts);
  await run(["bun", "add", join(artifacts, "create-shibumi.tgz")], artifacts);
  // Fail when a new template appears instead of silently omitting coverage.
  check(TEMPLATES.every(t => ["blog", "static", "full-stack"].includes(t)), "Add an acceptance journey for the new template");
  const order = [...TEMPLATES.filter(t => t !== "full-stack"), "full-stack"] as TemplateId[];
  for (const template of order) for (const round of [1, 2]) {
    console.log(`→ ${template} live journey ${round}/2`);
    log = join(artifacts, `${template}-${round}.log`);
    const result = { template, round, passed: false, commit: "", steps: [] as string[] };
    results.push(result);
    await install(template, round);
    result.steps.push("packed CLI scaffold and frozen install");
    if (template === "full-stack") {
      await run(["bun", join(root, "scripts/e2e.ts"), "live", targetPath], root);
      const report = JSON.parse(await readFile(join(target.directory, "live-results.json"), "utf8"));
      check(report.passed === true, "Full-stack journey did not pass");
      await cp(join(target.directory, "live-results.json"), join(artifacts, `${template}-${round}.json`));
      await cp(join(target.directory, "live-browser.png"), join(artifacts, `${template}-${round}.png`));
      result.steps.push(...report.steps.map((s: { step: string }) => s.step));
    } else {
      session = `shibumi-matrix-${crypto.randomUUID()}`;
      try {
        const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
        for (const script of ["test", "check", "build"]) if (pkg.scripts?.[script]) await run(["bun", "run", script]);
        await setupSite(template);
        result.steps.push("generated checks, build, generated-files review and Ship setup");
        const commitA = await ship();
        await version("a");
        await checkSite(template, "a", join(artifacts, `${template}-${round}-a.png`));
        result.steps.push("HTTPS pages, browser navigation, assets, MIME, HEAD, mutation rejection, 404" + (template === "blog" ? ", canonical/OG metadata, RSS, sitemap, Markdown, llms, robots, draft exclusion" : ""));
        const before = await readFile(join(app, "shibumi-server.json"), "utf8");
        await setupSite(template);
        check(await readFile(join(app, "shibumi-server.json"), "utf8") === before, "Setup changed configuration on repeat");
        result.steps.push("repeat setup without drift");
        await release(template, "b");
        await commit(`test: ${template} ${round} version B`);
        await ship();
        await version("b");
        const etagB = await checkSite(template, "b", join(artifacts, `${template}-${round}-b.png`));
        result.steps.push("redeploy changed content B");
        await rm(join(app, "public/healthz"));
        await release(template, "c");
        await commit(`test: ${template} ${round} deliberately unhealthy C`);
        try {
          await ship(true);
          await version("b");
          await checkSite(template, "b", join(artifacts, `${template}-${round}-recovered.png`));
          result.steps.push("server health failure restores B");
        } finally {
          await writeFile(join(app, "public/healthz"), "ok\n");
          await release(template, "b");
          await commit(`test: repair ${template} ${round} failure probe`);
          await run(["git", "push", "origin", "main"]);
        }
        await run(["bun", "run", "ship", "--", "--rollback", "--yes", "--server", target.server]);
        const status = JSON.parse(await ssh(["status", appId, "--json"]));
        check(status.commit === commitA && status.state === "succeeded", "Rollback commit mismatch");
        await version("a");
        if (etagB) {
          const path = template === "blog" ? "/posts/e2e-contract/" : "/";
          const revalidated = await fetch(origin + path, { headers: { "If-None-Match": etagB }, signal: AbortSignal.timeout(15_000) });
          check(revalidated.status === 200, "Rollback incorrectly returned 304 for version B's ETag");
          check((await revalidated.text()).includes("E2E release A."), "Conditional request did not return rolled-back HTML");
        }
        await checkSite(template, "a", join(artifacts, `${template}-${round}-rollback.png`));
        result.steps.push("rollback restores A pages and metadata");
      } catch (error) {
        await browser(["screenshot", join(artifacts, `${template}-${round}-failure.png`)]).catch(() => {});
        await evaluate(`(async () => { const r = await fetch('/', {cache:'no-store'}); return JSON.stringify({visibleRelease:document.body.innerText.match(/E2E release [ABC]\\./)?.[0], headers:Object.fromEntries(r.headers), serverRelease:(await r.text()).match(/E2E release [ABC]\\./)?.[0]}); })()`).catch(() => {});
        throw error;
      } finally {
        await browser(["close"]).catch(() => {});
        session = undefined;
      }
    }
    result.commit = JSON.parse(await ssh(["status", appId, "--json"])).commit;
    result.passed = true;
    await writeFile(join(artifacts, `${template}-${round}-history.json`), await ssh(["history", appId, "--json"]), { mode: 0o600 });
    console.log(`✓ ${template} ${round}/2`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  log = join(artifacts, "restore.log");
  if (snapshot && startedReplacing) {
    try {
      await clearFixture(true);
      await run(["tar", "-xf", join(artifacts, "original.tar"), "-C", app]);
      await run(["bun", "install", "--frozen-lockfile"]);
      await commit("test: restore original full-stack fixture after template matrix");
      await ship();
      const count = (await (await get("/api/counter")).json() as { count: number }).count;
      check(process.exitCode ? count >= initialCount : count === initialCount + results.filter(r => r.template === "full-stack" && r.passed).length, "Full-stack counter data did not survive template replacement");
      restored = true;
      console.log("✓ Original full-stack fixture restored and deployed; persistent counter retained");
    } catch (error) {
      console.error(`RESTORE FAILED: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  }
  await writeFile(join(artifacts, "results.json"), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), bun: Bun.version, templates: [...TEMPLATES], results, restored, passed: !process.exitCode && results.length === TEMPLATES.length * 2 && results.every(r => r.passed) }, null, 2) + "\n", { mode: 0o600 });
  await run(["ssh", "-S", join(control, "socket"), "-O", "exit", "--", target.server]).catch(() => {});
  await rm(control, { recursive: true, force: true });
  await rm(lock, { recursive: true, force: true });
  console.log(`Matrix results: ${join(artifacts, "results.json")}`);
}
