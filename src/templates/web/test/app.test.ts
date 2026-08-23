import { describe, expect, it } from "bun:test";
import { app, createApp } from "../src/app";

// Independent copy of the required header contract. If src/app.ts weakens a
// header, this literal makes the test fail instead of silently adapting.
const REQUIRED_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

async function req(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

function expectSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(REQUIRED_HEADERS)) {
    expect(res.headers.get(name)).toBe(value);
  }
}

describe("routes", () => {
  it("serves the home page", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("It runs.");
    // app.js must come before Alpine so the alpine:init listener registers
    // before Alpine starts.
    expect(html.indexOf("/public/app.js")).toBeLessThan(
      html.indexOf("/public/vendor/alpine-csp-3.16.2.min.js")
    );
    expectSecurityHeaders(res);
  });

  it("answers the health check", async () => {
    const res = await req("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expectSecurityHeaders(res);
  });

  it("validates API query input", async () => {
    const ok = await req("/api/hello?name=you");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ hello: "you" });

    const bad = await req(`/api/hello?name=${"x".repeat(101)}`);
    expect(bad.status).toBe(400);
    expectSecurityHeaders(bad);
  });

  it("returns 404 with security headers", async () => {
    const res = await req("/nope");
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  it("serves static assets with security headers", async () => {
    const res = await req("/public/style.css");
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  it("keeps security headers on thrown-error responses", async () => {
    // Fresh instance: the shared app's router freezes on first dispatch.
    const probe = createApp();
    probe.get("/__boom", () => {
      throw new Error("test explosion");
    });
    const res = await probe.fetch(new Request("http://localhost/__boom"));
    expect(res.status).toBe(500);
    expectSecurityHeaders(res);
  });
});

describe("security", () => {
  it("registers exactly the expected routes", () => {
    // Exact allowlist: any new route (including app.all handlers that could
    // hide a mutation endpoint) must be added here deliberately.
    const routes = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(routes.sort()).toEqual(
      [
        "ALL /*",
        "GET /public/*",
        "GET /",
        "GET /api/hello",
        "GET /healthz",
      ].sort()
    );
  });

  it("rejects every mutation verb on every route", async () => {
    for (const path of ["/", "/api/hello", "/healthz", "/public/style.css"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await req(path, { method });
        expect([404, 405]).toContain(res.status);
      }
    }
  });

  it("does not expose files outside public/ via traversal", async () => {
    for (const path of [
      "/public/../package.json",
      "/public/%2e%2e/package.json",
      "/public/..%2fpackage.json",
      "/public/%2e%2e%2fsrc/app.ts",
      "/public/..\\package.json",
      "/public/../.env",
    ]) {
      const res = await req(path);
      if (res.status === 200) {
        const body = await res.text();
        expect(body).not.toContain('"scripts"');
        expect(body).not.toContain("Bun.serve");
      } else {
        expect([400, 404]).toContain(res.status);
      }
    }
  });

  it("pins a CSP without unsafe-inline or unsafe-eval", () => {
    const csp = REQUIRED_HEADERS["Content-Security-Policy"]!;
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("ships the pinned Alpine build the page references", async () => {
    const file = Bun.file(new URL("../public/vendor/alpine-csp-3.16.2.min.js", import.meta.url));
    expect(await file.exists()).toBe(true);
  });
});
