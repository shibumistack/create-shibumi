import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Project-owned schema. Author changes here, then write a matching SQL
// migration in src/db/migrations/ (drizzle-kit generate drafts into
// src/db/drizzle/ for review; copy the reviewed SQL over).
export const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// One demo counter row (id fixed to 1). The page increments it through
// POST /api/counter, the only unauthenticated mutation in the template:
// rate-limited, clamped by a CHECK constraint, and holding no user data.
export const counters = sqliteTable("counters", {
  id: integer("id").primaryKey(),
  value: integer("value").notNull().default(0),
});
