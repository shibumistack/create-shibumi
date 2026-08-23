import { defineConfig } from "drizzle-kit";

// Authoring aid only: drizzle-kit generate drafts SQL into src/db/drizzle/,
// which the migration runner never reads. Review a draft, copy the SQL into
// src/db/migrations/ with the next filename, and commit both. Applying
// migrations is owned by scripts/db.ts, never drizzle-kit migrate.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/drizzle",
});
