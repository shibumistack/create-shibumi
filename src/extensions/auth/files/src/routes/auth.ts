// Auth routes, mounted at /auth by the installer. JSON bodies in, JSON out.
// CSRF middleware (Origin check) covers every mutation; cross-origin JSON
// posts are additionally blocked by the browser preflight. Rate limits key on
// the client IP, which is only meaningful behind the deployment proxy that
// sets x-forwarded-for; direct-exposed deployments share the "local" bucket.
import { Hono } from "hono";
import type { Context } from "hono";
import { csrf } from "hono/csrf";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  consumeLoginToken,
  createLoginToken,
  createSession,
  createUser,
  deliverLoginLink,
  destroySession,
  normalizeEmail,
  rateLimit,
  sessionUser,
  verifyLogin,
} from "../lib/auth";

export const authRoutes = new Hono();

authRoutes.use(csrf());

// `website` is a honeypot: a decoy field no real client sends. Bots that
// autofill it get a plausible response with no work done.
const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(8).max(128),
  website: z.string().optional(),
});

const emailOnly = z.object({
  email: z.email().max(254),
  website: z.string().optional(),
});

function honeypotTripped(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "website" in body &&
    typeof (body as { website: unknown }).website === "string" &&
    (body as { website: string }).website.length > 0
  );
}

function fakeRegisterResponse(c: Context, email: string): Response {
  // Shaped like the real 201 so the bot learns nothing; no account exists.
  return c.json(
    {
      user: {
        id: 1 + Math.floor(Math.random() * 100_000),
        email,
        createdAt: new Date().toISOString(),
      },
    },
    201
  );
}

const RATE_WINDOW_MS = 15 * 60 * 1000;

function clientKey(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function tooMany(c: Context): Response {
  return c.json({ error: "Too many attempts. Try again later." }, 429);
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

function setSessionCookie(c: Context, token: string): void {
  // Secure works in local development too: browsers treat localhost as a
  // secure context.
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: SESSION_MAX_AGE_S,
  });
}

authRoutes.post("/register", async (c) => {
  if (!rateLimit(`auth:register:${clientKey(c)}`, 10, RATE_WINDOW_MS)) return tooMany(c);
  const body = await jsonBody(c);
  const parsed = credentials.safeParse(body);
  if (honeypotTripped(body)) {
    return fakeRegisterResponse(c, parsed.success ? normalizeEmail(parsed.data.email) : "user@example.com");
  }
  if (!parsed.success) {
    return c.json({ error: "Provide a valid email and a password of 8 to 128 characters." }, 400);
  }
  try {
    const user = await createUser(parsed.data.email, parsed.data.password);
    setSessionCookie(c, await createSession(user.id));
    return c.json({ user }, 201);
  } catch {
    // UNIQUE constraint on email; the only failing insert path here.
    return c.json({ error: "Email is already registered." }, 409);
  }
});

authRoutes.post("/login", async (c) => {
  const body = await jsonBody(c);
  const parsed = credentials.safeParse(body);
  // Invalid shapes still consume rate budget keyed by IP alone.
  const email = parsed.success ? normalizeEmail(parsed.data.email) : "";
  if (!rateLimit(`auth:login:${clientKey(c)}:${email}`, 10, RATE_WINDOW_MS)) return tooMany(c);
  // Honeypot: answer exactly like a failed login, skip the work.
  const user =
    parsed.success && !honeypotTripped(body)
      ? await verifyLogin(parsed.data.email, parsed.data.password)
      : null;
  if (!user) return c.json({ error: "Invalid email or password." }, 401);
  setSessionCookie(c, await createSession(user.id));
  return c.json({ user });
});

authRoutes.post("/login-link", async (c) => {
  if (!rateLimit(`auth:link:${clientKey(c)}`, 5, RATE_WINDOW_MS)) return tooMany(c);
  const body = await jsonBody(c);
  const parsed = emailOnly.safeParse(body);
  if (!parsed.success) return c.json({ error: "Provide a valid email." }, 400);
  // Honeypot: the uniform response below already reveals nothing, so just
  // skip token creation and delivery.
  const token = honeypotTripped(body) ? null : await createLoginToken(parsed.data.email);
  if (token) {
    const url = new URL(`/auth/verify?token=${token}`, c.req.url).toString();
    try {
      await deliverLoginLink(normalizeEmail(parsed.data.email), url);
    } catch (error) {
      // Delivery failure must not change the response, or it would reveal
      // which emails have accounts.
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  return c.json({ ok: true, message: "If that email is registered, a login link is on its way." });
});

authRoutes.get("/verify", async (c) => {
  if (!rateLimit(`auth:verify:${clientKey(c)}`, 10, RATE_WINDOW_MS)) return tooMany(c);
  const token = c.req.query("token") ?? "";
  const user = token ? await consumeLoginToken(token) : null;
  if (!user) {
    return c.json({ error: "This login link is invalid or has expired. Request a new one." }, 400);
  }
  setSessionCookie(c, await createSession(user.id));
  return c.redirect("/");
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await destroySession(token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
  }
  return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await sessionUser(token) : null;
  return c.json({ user });
});
