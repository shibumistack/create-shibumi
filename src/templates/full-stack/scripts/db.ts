#!/usr/bin/env bun
// Owned database CLI: bun db:migrate | db:backup | db:restore <file> | db:status
// Restore must run with the app stopped; see agents.md for rollback semantics.
// Imports only ./lifecycle so restore never opens or creates the database
// before its checksum verifies.
import { appliedMigrations, applyMigrations, backupDatabase, hasUserTables, openDatabase, pendingMigrations, restoreDatabase } from "../src/db/lifecycle";
import { loadEnv } from "../src/env";

const env = loadEnv();
const [command, argument] = process.argv.slice(2);

try {
  if (command === "migrate") {
    const database = openDatabase(env.DB_PATH);
    if (pendingMigrations(database).length > 0 && hasUserTables(database)) {
      console.log(`Pre-migration backup: ${await backupDatabase(database, env.DB_PATH)}`);
    }
    const applied = await applyMigrations(database);
    console.log(applied.length > 0 ? `Applied: ${applied.join(", ")}` : "No pending migrations.");
  } else if (command === "backup") {
    const database = openDatabase(env.DB_PATH);
    console.log(`Backup written: ${await backupDatabase(database, env.DB_PATH)}`);
  } else if (command === "restore") {
    if (!argument) throw new Error("usage: bun db:restore <backup-file>. Stop the app first.");
    await restoreDatabase(argument, env.DB_PATH);
    console.log(`Restored ${env.DB_PATH} from ${argument}. Start the app to re-apply newer migrations.`);
  } else if (command === "status") {
    const database = openDatabase(env.DB_PATH);
    console.log(`Database: ${env.DB_PATH}`);
    console.log(`Applied:  ${appliedMigrations(database).join(", ") || "none"}`);
    console.log(`Pending:  ${pendingMigrations(database).map((m) => m.name).join(", ") || "none"}`);
  } else {
    console.error("usage: bun scripts/db.ts migrate|backup|restore <file>|status");
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
