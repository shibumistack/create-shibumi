/**
 * Cookie-based session management using Bun's built-in crypto and SQLite.
 * Zero external dependencies.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "fs";

const DB_DIR = "data";
const DB_PATH = `${DB_DIR}/auth.db`;
const SESSION_DURATION = 7 * 24 * 60 * 60 * 1000; // 7 days

// Ensure data directory exists
if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Create tables on startup
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS magic_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
  CREATE INDEX IF NOT EXISTS idx_magic_links_token ON magic_links(token);
`);

// ── Password hashing (Bun built-in) ────────────────────────────────

export function hashPassword(password: string): string {
  return Bun.password.hashSync(password);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

// ── User management ─────────────────────────────────────────────────

export interface User {
  id: number;
  email: string;
  created_at: string;
}

export function createUser(email: string, password: string): User {
  const hash = Bun.password.hashSync(password);
  const stmt = db.prepare(
    "INSERT INTO users (email, password_hash) VALUES (?, ?) RETURNING id, email, created_at"
  );
  return stmt.get(email, hash) as User;
}

export function getUserByEmail(email: string): (User & { password_hash: string | null }) | null {
  const stmt = db.prepare("SELECT * FROM users WHERE email = ?");
  return stmt.get(email) as (User & { password_hash: string | null }) | null;
}

export function getUserById(id: number): User | null {
  const stmt = db.prepare("SELECT id, email, created_at FROM users WHERE id = ?");
  return stmt.get(id) as User | null;
}

// ── Session management ──────────────────────────────────────────────

export function createSession(userId: number): string {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DURATION).toISOString();

  db.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)"
  ).run(token, userId, expiresAt);

  return token;
}

export function validateSession(token: string): number | null {
  const session = db
    .prepare("SELECT * FROM sessions WHERE token = ?")
    .get(token) as { user_id: number; expires_at: string } | undefined;

  if (!session) return null;

  if (new Date(session.expires_at) < new Date()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }

  return session.user_id;
}

export function destroySession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// ── Magic link management ───────────────────────────────────────────

export function createMagicLink(userId: number): string {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

  db.prepare(
    "INSERT INTO magic_links (token, user_id, expires_at) VALUES (?, ?, ?)"
  ).run(token, userId, expiresAt);

  return token;
}

export function validateMagicLink(
  token: string
): { userId: number; token: string } | null {
  const link = db
    .prepare("SELECT * FROM magic_links WHERE token = ? AND used = 0")
    .get(token) as { user_id: number; expires_at: string } | undefined;

  if (!link) return null;

  if (new Date(link.expires_at) < new Date()) {
    db.prepare("DELETE FROM magic_links WHERE token = ?").run(token);
    return null;
  }

  // Mark as used
  db.prepare("UPDATE magic_links SET used = 1 WHERE token = ?").run(token);

  return { userId: link.user_id, token };
}
