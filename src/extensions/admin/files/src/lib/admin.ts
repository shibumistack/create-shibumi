// Admin authorization and read models. Installed by
// `bun run shibumi add admin` (needs the auth extension). This project owns
// the file. Admins are defined by the ADMIN_EMAILS allowlist, not a database
// flag, so there is no schema coupling to the auth tables and no bootstrap
// step: set the env var and that account is an admin.
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import { users } from "../db/schema-auth";
import { loadEnv } from "../env";
import { normalizeEmail } from "./auth";

export function adminEmails(): Set<string> {
  const raw = loadEnv().ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => normalizeEmail(entry))
      .filter(Boolean)
  );
}

export function isAdmin(email: string): boolean {
  const allow = adminEmails();
  return allow.size > 0 && allow.has(normalizeEmail(email));
}

// Does a given table exist? Lets the admin read upload counts only when the
// uploads extension is installed, without importing its schema.
function tableExists(name: string): boolean {
  const row = sqlite
    .query<{ n: number }, [string]>("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return (row?.n ?? 0) > 0;
}

export interface AdminUserRow {
  id: number;
  email: string;
  createdAt: string;
  sessions: number;
  uploads: number | null;
}

export function listUsers(): AdminUserRow[] {
  const rows = db.select().from(users).all();
  const hasUploads = tableExists("uploads");
  const sessionCount = sqlite.query<{ n: number }, [number]>(
    "SELECT count(*) AS n FROM sessions WHERE user_id = ?"
  );
  const uploadCount = hasUploads
    ? sqlite.query<{ n: number }, [number]>("SELECT count(*) AS n FROM uploads WHERE user_id = ?")
    : null;
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    createdAt: row.createdAt,
    sessions: sessionCount.get(row.id)?.n ?? 0,
    uploads: uploadCount ? (uploadCount.get(row.id)?.n ?? 0) : null,
  }));
}

// Deleting a user cascades to sessions, login tokens, and uploads rows via the
// foreign keys those tables declare. Stored upload blobs are not swept here;
// the uploads extension owns that.
export async function deleteUser(id: number): Promise<boolean> {
  const removed = await db.delete(users).where(eq(users.id, id)).returning();
  return removed.length > 0;
}
