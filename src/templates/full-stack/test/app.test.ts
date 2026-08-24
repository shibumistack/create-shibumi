import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The db module opens DB_PATH at import time, so point it at a scratch
// database before the app loads.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "app-test-")), "app.db");
const { app, createApp } = await import("../src/app");
const { sqlite } = await import("../src/db");
const { applyMigrations } = await import("../src/db/lifecycle");
await applyMigrations(sqlite);

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
    expect(html).toContain("Full Stack app");
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

  it("serves notes from the migrated database", async () => {
    const res = await req("/api/notes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: Array<{ title: string }> };
    expect(body.notes.map((note) => note.title)).toContain("It persists.");
    expectSecurityHeaders(res);
  });

  it("validates API query input", async () => {
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
    const probe = createApp();
    probe.get("/__boom", () => {
      throw new Error("test explosion");
    });
    // onError logs the exception before answering; silence it so the
    // deliberate explosion does not read as a failure in test output.
    const errorLog = console.error;
    console.error = () => {};
    try {
      const res = await probe.fetch(new Request("http://localhost/__boom"));
      expect(res.status).toBe(500);
      expectSecurityHeaders(res);
    } finally {
      console.error = errorLog;
    }
  });
});

describe("security", () => {
  it("registers exactly the expected routes", () => {
    const routes = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(routes.sort()).toEqual(
      [
        "ALL /*",
        "GET /public/*",
        "GET /",
        "GET /api/hello",
        "GET /api/notes",
        "GET /api/counter",
        "POST /api/counter",
        "GET /healthz",
      ].sort()
    );
  });

  it("rejects every mutation verb on every route except the demo counter", async () => {
    for (const path of ["/", "/api/hello", "/api/notes", "/healthz", "/public/style.css"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await req(path, { method });
        expect([404, 405]).toContain(res.status);
      }
    }
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect([404, 405]).toContain((await req("/api/counter", { method })).status);
    }
  });

  it("persists counter increments in the database", async () => {
    const before = (await (await req("/api/counter")).json()).count;
    const res = await req("/api/counter", { method: "POST", headers: { "x-forwarded-for": "10.9.0.1" } });
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(before + 1);
    // A fresh read (what a reload does) sees the stored value.
    expect((await (await req("/api/counter")).json()).count).toBe(before + 1);
  });

  it("rate-limits counter increments per IP", async () => {
    let limited = false;
    for (let i = 0; i < 40; i++) {
      const res = await req("/api/counter", { method: "POST", headers: { "x-forwarded-for": "10.9.0.2" } });
      if (res.status === 429) { limited = true; break; }
    }
    expect(limited).toBe(true);
  });

  it("pins a CSP without unsafe-inline or unsafe-eval", () => {
    const csp = REQUIRED_HEADERS["Content-Security-Policy"]!;
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("does not expose files outside public/ via traversal", async () => {
    for (const path of [
      "/public/../package.json",
      "/public/%2e%2e/package.json",
      "/public/..%2fpackage.json",
      "/public/../.env",
    ]) {
      const res = await req(path);
      if (res.status === 200) {
        const body = await res.text();
        expect(body).not.toContain('"scripts"');
      } else {
        expect([400, 404]).toContain(res.status);
      }
    }
  });

  it("ships the pinned Alpine build the page references", async () => {
    const file = Bun.file(new URL("../public/vendor/alpine-csp-3.16.2.min.js", import.meta.url));
    expect(await file.exists()).toBe(true);
  });
});
