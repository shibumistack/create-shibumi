import { expect, test } from "bun:test";
import { assertOwnedConfig, parseTarget, assertOwnership, appIdForDomain } from "../scripts/e2e-target";

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
