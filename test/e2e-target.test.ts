import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertFixtureRemote, assertOwnedConfig, parseTarget, assertOwnership, appIdForDomain, mustRetainLock } from "../scripts/e2e-target";

const target = {
  directory: "/tmp/shibumi-e2e-check", domain: "e2e.example.com",
  server: "user@test-host", repository: "example/shibumi-e2e", disposable: true as const,
};

test("live acceptance refuses unsafe targets and mismatched registrations", () => {
  expect(parseTarget(target, "/src/project")).toEqual(target);
  for (const change of [
    { disposable: false }, { directory: "/src/project" }, { directory: "/src/project/out" },
    { directory: "/src" }, { directory: "/" }, { directory: "relative" }, { directory: "/tmp/../src" },
    { domain: "production.example.com" }, { domain: "e2e.example.com;id" },
    { server: "-oProxyCommand=id" }, { server: "host;id" }, { server: "host\nid" },
    { repository: "example/production" }, { repository: "example/e2e;id" },
  ]) expect(() => parseTarget({ ...target, ...change }, "/src/project")).toThrow();
  expect(appIdForDomain("e2e-run.example.com")).toBe("e2e--run-example-com");
  const config = { domain: target.domain, appId: "e2e-example-com", repository: `github:${target.repository}`, branch: "main", service: "app" };
  expect(() => assertOwnedConfig(config, target)).not.toThrow();
  for (const change of [{ domain: "other.example.com" }, { appId: "production" }, { repository: "github:example/production" }, { branch: "dev" }, { service: "web" }]) {
    expect(() => assertOwnedConfig({ ...config, ...change }, target)).toThrow();
  }

  expect(() => assertOwnership(200, "owner\n", "owner", true)).not.toThrow();
  for (const status of [undefined, 404, 502, 503]) {
    expect(() => assertOwnership(status, "", "owner", false)).not.toThrow();
    expect(() => assertOwnership(status, "", "owner", true)).toThrow();
  }
  for (const status of [200, 301, 401, 403, 500]) {
    expect(() => assertOwnership(status, "someone else's app", "owner", false)).toThrow();
  }
});

test("the matrix lock survives forced termination and unverified restoration", () => {
  for (const [state, expected] of [
    [{ startedReplacing: false, restored: false, unsafe: false }, false],
    [{ startedReplacing: false, restored: true, unsafe: false }, false],
    [{ startedReplacing: true, restored: true, unsafe: false }, false],
    [{ startedReplacing: true, restored: false, unsafe: false }, true],
    [{ startedReplacing: false, restored: false, unsafe: true }, true],
    [{ startedReplacing: true, restored: true, unsafe: true }, true],
  ] as const) expect(mustRetainLock(state)).toBe(expected);
});

test("all effective fetch and push URLs must match the dedicated repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "e2e-remote-test-"));
  const git = async (...args: string[]) => {
    const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    if (code) throw new Error(err);
    return out;
  };
  const good = `git@github.com:${target.repository}.git`;
  const bad = "git@github.com:example/production.git";
  const validate = () => assertFixtureRemote(target, args => git(...args.slice(1)));
  try {
    await git("init", "-q");
    await git("remote", "add", "origin", good);
    await validate();
    await git("config", "remote.origin.pushurl", bad);
    await expect(validate()).rejects.toThrow("push");
    await git("config", "--add", "remote.origin.pushurl", good);
    await expect(validate()).rejects.toThrow("push");
    await git("config", "--unset-all", "remote.origin.pushurl");
    await git("config", "url." + bad + ".pushInsteadOf", good);
    await expect(validate()).rejects.toThrow("push");
    await git("config", "--unset-all", "url." + bad + ".pushInsteadOf");
    await git("remote", "set-url", "--add", "origin", bad);
    await expect(validate()).rejects.toThrow("fetch");
    await git("remote", "set-url", "--delete", "origin", bad);
    await git("config", "url." + bad + ".insteadOf", good);
    await expect(validate()).rejects.toThrow("fetch");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
