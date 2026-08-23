/**
 * Auth middleware for Hono.
 *
 * Validates session cookie and attaches user to context.
 * Redirects to /auth/login if not authenticated.
 *
 * Usage:
 *   import { authMiddleware } from "./middleware/auth";
 *   app.use("/protected/*", authMiddleware);
 */

import { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { validateSession, getUserById } from "../lib/session";

/**
 * Required auth: redirects to login if not authenticated.
 */
export async function authMiddleware(c: Context, next: Next) {
  const token = getCookie(c, "session");

  if (!token) {
    return c.redirect("/auth/login");
  }

  const userId = validateSession(token);

  if (!userId) {
    return c.redirect("/auth/login");
  }

  const user = getUserById(userId);
  c.set("user", user);
  c.set("userId", userId);

  await next();
}

/**
 * Optional auth: attaches user if valid session exists, but doesn't block.
 */
export async function optionalAuth(c: Context, next: Next) {
  const token = getCookie(c, "session");

  if (token) {
    const userId = validateSession(token);
    if (userId) {
      const user = getUserById(userId);
      c.set("user", user);
      c.set("userId", userId);
    }
  }

  await next();
}
