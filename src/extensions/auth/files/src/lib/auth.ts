// Auth core: users, hashed cookie sessions, single-use login tokens, and a
// fixed-window rate limiter. Installed by `bun run shibumi add auth`; this
// project owns the file. Full guide: agents/auth.md.
//
// Invariants:
// - Session and login tokens leave this module only as opaque random strings;
//   the database stores sha256 hashes, so a leaked database cannot mint
//   sessions or logins.
// - Login tokens are single-use (deleted on first consume, valid or not) and
//   expire after 15 minutes.
// - Password checks always run Bun.password.verify, including for unknown
//   emails, so response timing does not reveal whether an account exists.
// - The rate limiter is in-memory and per-process, which matches the
//   single-container deployment; counts reset on restart.
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { eq, lt } from "drizzle-orm";
import { db } from "../db";
import { loginTokens, sessions, users } from "../db/schema-auth";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

export const SESSION_COOKIE = "session";
export const SESSION_MAX_AGE_S = SESSION_TTL_MS / 1000;

export interface AuthUser {
  id: number;
  email: string;
  createdAt: string;
}

type UserRow = typeof users.$inferSelect;

function toAuthUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.email, createdAt: row.createdAt };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

// Users ----------------------------------------------------------------------

// Throws on duplicate email (UNIQUE constraint); routes map that to 409.
export async function createUser(email: string, password: string | null): Promise<AuthUser> {
  const passwordHash = password === null ? null : await Bun.password.hash(password);
  const rows = await db
    .insert(users)
    .values({ email: normalizeEmail(email), passwordHash })
    .returning();
  return toAuthUser(rows[0]!);
}

export async function getUserByEmail(email: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  return rows[0] ?? null;
}

export async function getUserById(id: number): Promise<AuthUser | null> {
  const rows = await db.select().from(users).where(eq(users.id, id));
  return rows[0] ? toAuthUser(rows[0]) : null;
}

// Verifying against this hash when the account is missing (or has no
// password) keeps timing uniform without ever granting access: the guard
// below requires the account's own stored hash to have matched.
let dummyHashPromise: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= Bun.password.hash(crypto.randomUUID());
  return dummyHashPromise;
}
// Warm it at import so the first unknown-email login is not measurably
// slower than a known-email one.
void dummyHash();

export async function verifyLogin(email: string, password: string): Promise<AuthUser | null> {
  const row = await getUserByEmail(email);
  const ok = await Bun.password.verify(password, row?.passwordHash ?? (await dummyHash()));
  if (!ok || !row?.passwordHash) return null;
  return toAuthUser(row);
}

// Sessions -------------------------------------------------------------------

export async function createSession(userId: number): Promise<string> {
  // Login is the write path, so piggyback expired-row cleanup here and keep
  // per-request session reads to a single lookup.
  await db.delete(sessions).where(lt(sessions.expiresAt, nowIso()));
  const token = newToken();
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  return token;
}

export async function sessionUser(token: string): Promise<AuthUser | null> {
  const tokenHash = hashToken(token);
  const rows = await db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash));
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt <= nowIso()) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    return null;
  }
  return toAuthUser(row.user);
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

// Login tokens (login-link flow) ----------------------------------------------

export async function createLoginToken(email: string): Promise<string | null> {
  const row = await getUserByEmail(email);
  if (!row) return null;
  await db.delete(loginTokens).where(lt(loginTokens.expiresAt, nowIso()));
  const token = newToken();
  await db.insert(loginTokens).values({
    tokenHash: hashToken(token),
    userId: row.id,
    expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS).toISOString(),
  });
  return token;
}

export async function consumeLoginToken(token: string): Promise<AuthUser | null> {
  // Delete first: the token is spent by the attempt, even an expired one.
  const rows = await db
    .delete(loginTokens)
    .where(eq(loginTokens.tokenHash, hashToken(token)))
    .returning();
  const row = rows[0];
  if (!row || row.expiresAt <= nowIso()) return null;
  return getUserById(row.userId);
}

// Delivery seam: the auth extension does not send email itself. With the
// email extension installed (bun run shibumi add email), replace the body
// with a sendEmail call; agents/auth.md has the exact snippet. Until then,
// development logs the link and production refuses instead of silently
// swallowing logins.
export async function deliverLoginLink(email: string, url: string): Promise<void> {
  // Deliberate direct env read: NODE_ENV selects behavior, it is not app
  // config. Fail-closed: only explicit development logs the link; any other
  // value (including unset) refuses rather than printing tokens to output.
  if (process.env.NODE_ENV !== "development") {
    throw new Error(
      "Login-link delivery is not wired. Install the email extension (bun run shibumi add email) and connect it in src/lib/auth.ts (see agents/auth.md)."
    );
  }
  console.log(`Login link for ${email}: ${url}`);
}

// Rate limiting ---------------------------------------------------------------

interface RateWindow {
  start: number;
  count: number;
}

const rateWindows = new Map<string, RateWindow>();
// Hard bound on tracked windows so attacker-minted keys (fresh IPs or
// emails) cannot grow memory without limit. At the cap, expired windows are
// pruned and, if every window is still live, the oldest are evicted; an
// attacker filling the map can reset other buckets, but the memory bound
// wins over that marginal rate-limit weakening.
const RATE_MAP_CAP = 10_000;

// Returns true while the caller stays within `limit` hits per `windowMs`.
export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const window = rateWindows.get(key);
  if (window && now - window.start < windowMs) {
    window.count += 1;
    return window.count <= limit;
  }
  if (!window && rateWindows.size >= RATE_MAP_CAP) {
    for (const [staleKey, stale] of rateWindows) {
      if (now - stale.start >= windowMs) rateWindows.delete(staleKey);
    }
    while (rateWindows.size >= RATE_MAP_CAP) {
      const oldest = rateWindows.keys().next().value;
      if (oldest === undefined) break;
      rateWindows.delete(oldest);
    }
  }
  rateWindows.set(key, { start: now, count: 1 });
  return true;
}

// Middleware -------------------------------------------------------------------

export type AuthEnv = { Variables: { user: AuthUser } };

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await sessionUser(token) : null;
  if (!user) return c.json({ error: "Authentication required" }, 401);
  c.set("user", user);
  await next();
}

export async function optionalAuth(c: Context, next: Next): Promise<void> {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const user = await sessionUser(token);
    if (user) c.set("user", user);
  }
  await next();
}
