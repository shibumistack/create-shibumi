import { isAbsolute, relative, resolve, sep } from "node:path";

export interface E2ETarget {
  directory: string;
  domain: string;
  server: string;
  repository: string;
  disposable: true;
}

export function parseTarget(value: unknown, checkout: string): E2ETarget {
  if (!value || typeof value !== "object") throw new Error("Expected target JSON object");
  const t = value as Record<string, unknown>;
  if (t.disposable !== true) throw new Error("Target must explicitly declare disposable: true");
  if (typeof t.directory !== "string" || !isAbsolute(t.directory) || resolve(t.directory) !== t.directory) throw new Error("directory must be a normalized absolute path");
  const rel = relative(resolve(checkout), t.directory);
  const parent = relative(t.directory, resolve(checkout));
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== "..") || !parent || (!parent.startsWith(`..${sep}`) && parent !== "..")) {
    throw new Error("directory must be outside and not contain the source checkout");
  }
  if (typeof t.domain !== "string" || t.domain.length > 253 || !/^e2e(?:-[a-z0-9]+)?\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(t.domain)) throw new Error("domain must start with an e2e label");
  if (typeof t.server !== "string" || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(t.server)) throw new Error("Unsafe SSH target");
  if (typeof t.repository !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/(?:e2e|[a-zA-Z0-9_.-]+-e2e)(?:-[a-zA-Z0-9_.-]+)?$/.test(t.repository)) throw new Error("repository must have an e2e name (owner/project-e2e)");
  return t as unknown as E2ETarget;
}

export function appIdForDomain(domain: string): string {
  return domain.replaceAll("-", "--").replaceAll(".", "-");
}

export function assertOwnership(status: number | undefined, body: string, owner: string, previouslyDeployed: boolean): void {
  if (status === 200 && body.trim() === owner) return;
  if (!previouslyDeployed && (status === undefined || [404, 502, 503].includes(status))) return;
  throw new Error("Domain is not owned by this fixture; refusing deployment");
}

export function assertOwnedConfig(value: unknown, target: E2ETarget): void {
  if (!value || typeof value !== "object") throw new Error("Missing server registration");
  const c = value as Record<string, unknown>;
  if (c.domain !== target.domain || c.appId !== appIdForDomain(target.domain) || c.repository !== `github:${target.repository}` || c.branch !== "main" || c.service !== "app") {
    throw new Error("Registration does not match the dedicated test domain, app, repository, branch and Compose service (app)");
  }
}
