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
