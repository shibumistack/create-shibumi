/**
 * Auth routes: password login and magic link login.
 *
 * Password flow:
 *   POST /auth/register: create account
 *   POST /auth/login: login with email/password
 *
 * Magic link flow:
 *   POST /auth/magic-request: request a magic link (sends email)
 *   GET  /auth/magic-verify: verify token from email link
 *
 * Both:
 *   POST /auth/logout: destroy session
 */

import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  createUser,
  getUserByEmail,
  getUserById,
  createSession,
  destroySession,
  validateSession,
  createMagicLink,
  validateMagicLink,
} from "../lib/session";

export const authRoutes = new Hono();

// ── Register (password) ─────────────────────────────────────────────

authRoutes.post("/register", async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400);
  }

  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  const existing = getUserByEmail(email);
  if (existing) {
    return c.json({ error: "Email already registered" }, 409);
  }

  const user = createUser(email, password);
  const token = createSession(user.id);

  setCookie(c, "session", token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60,
  });

  return c.json({ ok: true, user: { id: user.id, email: user.email } });
});

// ── Login (password) ────────────────────────────────────────────────

authRoutes.post("/login", async (c) => {
  const { email, password } = await c.req.json();

  if (!email || !password) {
    return c.json({ error: "Email and password required" }, 400);
  }

  const user = getUserByEmail(email);
  if (!user || !user.password_hash) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const valid = await Bun.password.verify(password, user.password_hash);
  if (!valid) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const token = createSession(user.id);

  setCookie(c, "session", token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60,
  });

  return c.json({ ok: true, user: { id: user.id, email: user.email } });
});

// ── Request magic link ──────────────────────────────────────────────

authRoutes.post("/magic-request", async (c) => {
  const { email } = await c.req.json();

  if (!email) {
    return c.json({ error: "Email required" }, 400);
  }

  const user = getUserByEmail(email);

  // Always return success to prevent email enumeration
  if (!user) {
    return c.json({ ok: true, message: "If that email is registered, a link was sent" });
  }

  const token = createMagicLink(user.id);
  const verifyUrl = `/auth/magic-verify?token=${token}`;

  // TODO: Send email with verifyUrl
  // For now, log it (in production, use the email extension)
  console.log(`Magic link for ${email}: ${verifyUrl}`);

  return c.json({ ok: true, message: "If that email is registered, a link was sent" });
});

// ── Verify magic link ───────────────────────────────────────────────

authRoutes.get("/magic-verify", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.json({ error: "Token required" }, 400);
  }

  const result = validateMagicLink(token);
  if (!result) {
    return c.json({ error: "Invalid or expired link" }, 400);
  }

  const sessionToken = createSession(result.userId);

  setCookie(c, "session", sessionToken, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60,
  });

  return c.redirect("/");
});

// ── Logout ──────────────────────────────────────────────────────────

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, "session");
  if (token) {
    destroySession(token);
    deleteCookie(c, "session", { path: "/" });
  }
  return c.json({ ok: true });
});

// ── Current user ────────────────────────────────────────────────────

authRoutes.get("/me", async (c) => {
  const token = getCookie(c, "session");
  if (!token) {
    return c.json({ user: null });
  }

  const userId = validateSession(token);
  if (!userId) {
    return c.json({ user: null });
  }

  const user = getUserById(userId);
  return c.json({ user });
});
