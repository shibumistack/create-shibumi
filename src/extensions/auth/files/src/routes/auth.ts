// Auth routes, mounted at /auth by the installer. JSON bodies in, JSON out.
// CSRF middleware (Origin check) covers every mutation; cross-origin JSON
// posts are additionally blocked by the browser preflight. Rate limits key on
// the client IP; see clientKey for how x-forwarded-for is trusted.
import { Hono } from "hono";
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";
import { csrf } from "hono/csrf";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { loadEnv } from "../env";
import {
  LOGIN_LINK_RATE,
  LOGIN_RATE,
  PASSWORD_MIN_LENGTH,
  RATE_WINDOW_MS,
  REGISTER_RATE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  consumeLoginToken,
  createLoginToken,
  createSession,
  createUser,
  deliverLoginLink,
  destroySession,
  isReservedEmail,
  nodeEnv,
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
  password: z.string().min(PASSWORD_MIN_LENGTH).max(128),
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
  // Shaped like the real 201, decoy session cookie included, so the bot
  // learns nothing; no account or session exists.
  const decoy = new Uint8Array(32);
  crypto.getRandomValues(decoy);
  setSessionCookie(c, Buffer.from(decoy).toString("base64url"));
  return c.json(
    {
      user: {
        id: 1 + Math.floor(Math.random() * 1000),
        email,
        createdAt: new Date().toISOString(),
      },
    },
    201
  );
}

function isPrivateAddress(addr: string): boolean {
  const ip = addr.replace(/^::ffff:/, "");
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fd") ||
    ip.startsWith("fc")
  );
}

// Rate-limit key. x-forwarded-for is trusted only when the direct socket peer
// is a local reverse proxy (the shibumi-server / Caddy deployment) or when
// there is no socket peer at all (non-served test context). A directly
// reachable production app has a public peer and keys on it, so a spoofed
// x-forwarded-for cannot rotate rate-limit buckets.
function clientKey(c: Context): string {
  let peer = "";
  try {
    peer = getConnInfo(c).remote.address ?? "";
  } catch {
    peer = "";
  }
  // A reverse proxy APPENDS the client it saw to x-forwarded-for, so the last
  // entry is the one the trusted proxy added; the leftmost is attacker-set and
  // must never be used as a key. Trust the header only when the direct peer is
  // a local proxy (or, in tests, there is no socket peer).
  if (!peer || isPrivateAddress(peer)) {
    const entries = c.req.header("x-forwarded-for")?.split(",").map((part) => part.trim()).filter(Boolean);
    const last = entries?.at(-1);
    if (last) return last;
  }
  return peer || "local";
}

function tooMany(c: Context): Response {
  return c.json({ error: "Too many attempts. Try again later." }, 429);
}

// Auth bodies are tiny (email + password). Reject anything larger before
// buffering, so an app that raised the server's global maxRequestBodySize for
// another feature (e.g. uploads) does not expose these routes to oversized
// JSON. Content-Length covers the common case; the server's global limit
// remains the hard ceiling for chunked requests.
const MAX_AUTH_BODY_BYTES = 4 * 1024;
async function jsonBody(c: Context): Promise<unknown> {
  // Cap the actual bytes read, not just the declared Content-Length, so a
  // chunked or length-spoofed request cannot buffer up to the server's global
  // ceiling (raised by e.g. the uploads extension). Auth bodies are tiny.
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_AUTH_BODY_BYTES) return null;
  const body = c.req.raw.body;
  if (!body) {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_AUTH_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return null;
  }
}

function setSessionCookie(c: Context, token: string): void {
  // A token-bearing response must never be cached by a shared proxy.
  c.header("Cache-Control", "no-store");
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
  if (!rateLimit(`auth:register:${clientKey(c)}`, REGISTER_RATE, RATE_WINDOW_MS)) return tooMany(c);
  const body = await jsonBody(c);
  const parsed = credentials.safeParse(body);
  if (honeypotTripped(body)) {
    return fakeRegisterResponse(c, parsed.success ? normalizeEmail(parsed.data.email) : "user@example.com");
  }
  if (!parsed.success) {
    return c.json({ error: `Provide a valid email and a password of ${PASSWORD_MIN_LENGTH} to 128 characters.` }, 400);
  }
  if (isReservedEmail(parsed.data.email)) {
    // Privileged address: cannot be self-registered; must sign in via the
    // login link (inbox proof) or be seeded by the operator.
    return c.json({ error: "This address is reserved. Sign in with a login link." }, 403);
  }
  try {
    const user = await createUser(parsed.data.email, parsed.data.password);
    setSessionCookie(c, await createSession(user.id));
    return c.json({ user }, 201);
  } catch (error) {
    // Only the duplicate-email case maps to 409; anything else (hashing,
    // database, session failure) surfaces as the generic 500.
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      return c.json({ error: "Email is already registered." }, 409);
    }
    throw error;
  }
});

authRoutes.post("/login", async (c) => {
  const body = await jsonBody(c);
  const parsed = credentials.safeParse(body);
  // Invalid shapes still consume rate budget keyed by IP alone.
  const email = parsed.success ? normalizeEmail(parsed.data.email) : "";
  if (!rateLimit(`auth:login:${clientKey(c)}:${email}`, LOGIN_RATE, RATE_WINDOW_MS)) return tooMany(c);
  // IP-independent per-account bucket: credential stuffing from many IPs
  // still hits a ceiling.
  if (email && !rateLimit(`auth:login:email:${email}`, LOGIN_RATE * 5, RATE_WINDOW_MS)) return tooMany(c);
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
  if (!rateLimit(`auth:link:${clientKey(c)}`, LOGIN_LINK_RATE, RATE_WINDOW_MS)) return tooMany(c);
  const body = await jsonBody(c);
  const parsed = emailOnly.safeParse(body);
  if (!parsed.success) return c.json({ error: "Provide a valid email." }, 400);
  // Honeypot: the uniform response below already reveals nothing, so just
  // skip token creation and delivery.
  // Per-email bucket, uniform response when exceeded: rotating IPs must not
  // turn login links into email bombing or a stack of live tokens.
  const emailAllowed = rateLimit(`auth:link:email:${normalizeEmail(parsed.data.email)}`, LOGIN_LINK_RATE, RATE_WINDOW_MS);
  const token =
    honeypotTripped(body) || !emailAllowed ? null : await createLoginToken(parsed.data.email);
  if (token) {
    // Links are built from APP_ORIGIN, never the Host header, so a poisoned
    // Host cannot redirect tokens. Fail-closed: the request-origin fallback
    // is used only when NODE_ENV is explicitly "development"; any other value
    // (including unset) requires APP_ORIGIN, and it must be https so tokens
    // never ride plaintext.
    const env = loadEnv();
    const isDevelopment = nodeEnv() === "development";
    const base = env.APP_ORIGIN ?? (isDevelopment ? new URL(c.req.url).origin : null);
    try {
      if (!base) {
        throw new Error("APP_ORIGIN is not set; refusing to build login links from the Host header. Set APP_ORIGIN (https://...).");
      }
      if (!isDevelopment && !base.startsWith("https://")) {
        throw new Error(`APP_ORIGIN must be https in production, got ${base}.`);
      }
      const url = new URL(`/auth/verify?token=${token}`, base).toString();
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
  if (!rateLimit(`auth:verify:${clientKey(c)}`, LOGIN_RATE, RATE_WINDOW_MS)) return tooMany(c);
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
