import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The db module opens DB_PATH at import time, so point it at a scratch
// database before the app loads. When another test file loaded first, its
// scratch path already won; migrations below are idempotent either way.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "auth-test-")), "app.db");
const { app } = await import("../src/app");
const { db, sqlite } = await import("../src/db");
const { applyMigrations } = await import("../src/db/lifecycle");
const { sessions } = await import("../src/db/schema-auth");
const {
  consumeLoginToken,
  createLoginToken,
  deliverLoginLink,
  createSession,
  createUser,
  hashToken,
  rateLimit,
  sessionUser,
} = await import("../src/lib/auth");
const { eq } = await import("drizzle-orm");
await applyMigrations(sqlite);

let userCounter = 0;
function uniqueEmail(): string {
  userCounter += 1;
  return `user${userCounter}-${Date.now()}@example.com`;
}

let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

async function post(
  path: string,
  body: unknown,
  options: { ip?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": options.ip ?? uniqueIp(),
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(body),
    })
  );
}

function sessionTokenFrom(res: Response): string {
  const cookie = res.headers.get("set-cookie") ?? "";
  const match = cookie.match(/session=([^;]+)/);
  expect(match).not.toBeNull();
  return match![1]!;
}

describe("register and login", () => {
  it("registers, sets a hardened session cookie, and stores only the token hash", async () => {
    const email = uniqueEmail();
    const res = await post("/auth/register", { email, password: "password123" });
    expect(res.status).toBe(201);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");

    const token = sessionTokenFrom(res);
    const rows = await db.select().from(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    expect(rows.length).toBe(1);
    expect(rows[0]!.tokenHash).not.toBe(token);
  });

  it("reserves ADMIN_EMAILS addresses from self-service registration", async () => {
    const reserved = uniqueEmail();
    const original = process.env.ADMIN_EMAILS;
    process.env.ADMIN_EMAILS = `${reserved}, someone-else@example.com`;
    try {
      const res = await post("/auth/register", { email: reserved, password: "password123" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("reserved");
      // A non-reserved address still registers.
      expect((await post("/auth/register", { email: uniqueEmail(), password: "password123" })).status).toBe(201);
      // Reserved address can still get a login link (inbox proof).
      const link = await post("/auth/login-link", { email: reserved });
      expect(link.status).toBe(200);
    } finally {
      if (original === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = original;
    }
  });

  it("rejects duplicate registration with 409", async () => {
    const email = uniqueEmail();
    expect((await post("/auth/register", { email, password: "password123" })).status).toBe(201);
    expect((await post("/auth/register", { email, password: "password123" })).status).toBe(409);
  });

  it("rejects invalid registration input", async () => {
    expect((await post("/auth/register", { email: "not-an-email", password: "password123" })).status).toBe(400);
    expect((await post("/auth/register", { email: uniqueEmail(), password: "short" })).status).toBe(400);
  });

  it("logs in with correct credentials and returns one uniform error otherwise", async () => {
    const email = uniqueEmail();
    await post("/auth/register", { email, password: "password123" });

    const ok = await post("/auth/login", { email, password: "password123" });
    expect(ok.status).toBe(200);

    const wrongPassword = await post("/auth/login", { email, password: "wrong-password" });
    const unknownEmail = await post("/auth/login", { email: uniqueEmail(), password: "password123" });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
  });

  it("honeypot submissions get plausible responses but create nothing", async () => {
    const email = uniqueEmail();
    const trapped = await post("/auth/register", {
      email,
      password: "password123",
      website: "https://spam.example",
    });
    expect(trapped.status).toBe(201);
    // A decoy cookie is set so the response is indistinguishable, but it
    // maps to no session.
    const decoy = (trapped.headers.get("set-cookie") ?? "").match(/session=([^;]+)/)![1]!;
    const decoyMe = await app.fetch(
      new Request("http://localhost/auth/me", { headers: { cookie: `session=${decoy}` } })
    );
    expect(((await decoyMe.json()) as { user: null }).user).toBeNull();

    // No account was created, so a real login with those credentials fails.
    const login = await post("/auth/login", { email, password: "password123" });
    expect(login.status).toBe(401);

    const trappedLogin = await post("/auth/login", {
      email,
      password: "password123",
      website: "x",
    });
    expect(trappedLogin.status).toBe(401);

    const trappedLink = await post("/auth/login-link", { email, website: "x" });
    const realLink = await post("/auth/login-link", { email: uniqueEmail() });
    expect(trappedLink.status).toBe(200);
    expect(await trappedLink.json()).toEqual(await realLink.json());

    // An empty honeypot field is what real clients send; it must not trip.
    const clean = await post("/auth/register", {
      email: uniqueEmail(),
      password: "password123",
      website: "",
    });
    expect(clean.status).toBe(201);
    expect(clean.headers.get("set-cookie")).not.toBeNull();
  });

  it("rate limits login attempts per IP and email", async () => {
    const email = uniqueEmail();
    const ip = uniqueIp();
    let limited = false;
    for (let i = 0; i < 11; i++) {
      const res = await post("/auth/login", { email, password: "wrong-password" }, { ip });
      if (res.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });

  it("caps an oversized request body (treated as an invalid body)", async () => {
    // The 4 KiB cap makes jsonBody return null; register reports that as 400.
    const res = await app.fetch(
      new Request("http://localhost/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": uniqueIp() },
        body: JSON.stringify({ email: "big@example.com", password: "a".repeat(20 * 1024) }),
      })
    );
    expect(res.status).toBe(400);
  });

  it("keys the rate limit on the proxy-appended (rightmost) forwarded IP", async () => {
    // The trusted proxy appends the real client; a spoofed leftmost entry must
    // not create fresh buckets. Fixed rightmost, varying leftmost -> one bucket.
    const realIp = uniqueIp();
    let limited = false;
    for (let i = 0; i < 7; i++) {
      const res = await app.fetch(
        new Request("http://localhost/auth/login-link", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": `203.0.113.${i}, ${realIp}`,
          },
          body: JSON.stringify({ email: `r${i}@example.com` }),
        })
      );
      if (res.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

describe("sessions", () => {
  it("reports the user on /auth/me and clears the session on logout", async () => {
    const email = uniqueEmail();
    const res = await post("/auth/register", { email, password: "password123" });
    const token = sessionTokenFrom(res);
    const withCookie = { cookie: `session=${token}` };

    const me = await app.fetch(new Request("http://localhost/auth/me", { headers: withCookie }));
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(email);

    const logout = await post("/auth/logout", {}, { headers: withCookie });
    expect(logout.status).toBe(200);

    const meAfter = await app.fetch(new Request("http://localhost/auth/me", { headers: withCookie }));
    expect(((await meAfter.json()) as { user: null }).user).toBeNull();
  });

  it("rejects expired sessions", async () => {
    const user = await createUser(uniqueEmail(), "password123");
    const token = await createSession(user.id);
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(sessions.tokenHash, hashToken(token)));
    expect(await sessionUser(token)).toBeNull();
  });

  it("blocks cross-origin form posts (CSRF)", async () => {
    const res = await app.fetch(
      new Request("http://localhost/auth/logout", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
          "x-forwarded-for": uniqueIp(),
        },
        body: "a=1",
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("login links", () => {
  it("answers uniformly whether or not the email exists", async () => {
    const email = uniqueEmail();
    await post("/auth/register", { email, password: "password123" });
    const known = await post("/auth/login-link", { email });
    const unknown = await post("/auth/login-link", { email: uniqueEmail() });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it("issues high-entropy single-use tokens that log the user in once", async () => {
    const email = uniqueEmail();
    const user = await createUser(email, null);
    const token = await createLoginToken(email);
    expect(token).not.toBeNull();
    // 32 random bytes, base64url: 43 characters, unique per issue.
    expect(token!.length).toBeGreaterThanOrEqual(43);
    expect(await createLoginToken(email)).not.toBe(token);

    const consumed = await consumeLoginToken(token!);
    expect(consumed?.id).toBe(user.id);
    expect(await consumeLoginToken(token!)).toBeNull();
  });

  it("verify endpoint consumes the token and starts a session", async () => {
    const email = uniqueEmail();
    await createUser(email, null);
    const token = await createLoginToken(email);
    const res = await app.fetch(
      new Request(`http://localhost/auth/verify?token=${token}`, {
        headers: { "x-forwarded-for": uniqueIp() },
      })
    );
    expect(res.status).toBe(302);
    expect(sessionTokenFrom(res).length).toBeGreaterThan(0);

    const again = await app.fetch(
      new Request(`http://localhost/auth/verify?token=${token}`, {
        headers: { "x-forwarded-for": uniqueIp() },
      })
    );
    expect(again.status).toBe(400);
  });

  it("rejects expired login tokens", async () => {
    const email = uniqueEmail();
    await createUser(email, null);
    const token = await createLoginToken(email);
    const { loginTokens } = await import("../src/db/schema-auth");
    await db
      .update(loginTokens)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(loginTokens.tokenHash, hashToken(token!)));
    expect(await consumeLoginToken(token!)).toBeNull();
  });
});

describe("login-link delivery seam", () => {
  it("refuses to emit links unless NODE_ENV is explicitly development", async () => {
    const original = process.env.NODE_ENV;
    try {
      delete process.env.NODE_ENV;
      await expect(deliverLoginLink("user@example.com", "https://app.example/x")).rejects.toThrow(
        "not wired"
      );
      process.env.NODE_ENV = "production";
      await expect(deliverLoginLink("user@example.com", "https://app.example/x")).rejects.toThrow(
        "not wired"
      );
      process.env.NODE_ENV = "development";
      await deliverLoginLink("user@example.com", "https://app.example/x");
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });
});

describe("rate limiter", () => {
  it("enforces the window and resets after it passes", () => {
    const start = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(rateLimit("test:key", 3, 1000, start + i)).toBe(true);
    }
    expect(rateLimit("test:key", 3, 1000, start + 3)).toBe(false);
    expect(rateLimit("test:key", 3, 1000, start + 1001)).toBe(true);
  });

  it("stays bounded under attacker-minted keys", () => {
    const start = 2_000_000;
    // Well past the 10,000-window cap; must neither throw nor block fresh keys.
    for (let i = 0; i < 10_500; i++) {
      expect(rateLimit(`flood:${i}`, 3, 60_000, start + i)).toBe(true);
    }
    expect(rateLimit("flood:final", 3, 60_000, start + 11_000)).toBe(true);
  });
});

describe("csrfOptions", () => {
  it("pins the CSRF origin to APP_ORIGIN so browser form posts work behind a TLS proxy", async () => {
    process.env.APP_ORIGIN = "https://app.example.com";
    try {
      const { csrfOptions } = await import("../src/lib/auth");
      expect(csrfOptions()).toEqual({ origin: "https://app.example.com" });
      const { Hono } = await import("hono");
      const { csrf } = await import("hono/csrf");
      const probe = new Hono();
      probe.use(csrf(csrfOptions()));
      probe.post("/x", (c) => c.text("ok"));
      const form = (origin: string) =>
        new Request("http://app.example.com/x", {
          method: "POST",
          headers: { origin, "content-type": "application/x-www-form-urlencoded" },
          body: "a=1",
        });
      // Request URL is http:// (what the app sees behind Caddy); the browser
      // sends the https origin. Default csrf() rejects this; pinned passes.
      expect((await probe.fetch(form("https://app.example.com"))).status).toBe(200);
      expect((await probe.fetch(form("https://evil.example"))).status).toBe(403);
    } finally {
      delete process.env.APP_ORIGIN;
    }
  });

  it("keeps the same-origin default when APP_ORIGIN is unset", async () => {
    const { csrfOptions } = await import("../src/lib/auth");
    expect(csrfOptions()).toEqual({});
  });
});
