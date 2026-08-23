// Owned database lifecycle: migrations, backups, restore.
//
// Boot ordering (src/server.ts): integrity check -> backup -> migrate -> serve.
// A failed step exits the process, the container never reports healthy, and
// shibumi-server keeps the previous deployment. Image rollback
// (bun ship --rollback) does NOT reverse schema or data changes; use
// `bun db:restore <backup>` for that, with the app stopped.
//
// Backup contract:
// - method: VACUUM INTO (consistent snapshot, safe under WAL)
// - trigger: automatically before applying pending migrations to a database
//   that already has tables; manually via `bun db:backup`
// - location: <db-dir>/backups/<name>.<utc-timestamp>.sqlite + .sha256 sidecar
// - retention: newest 5 backups for this database kept; other files untouched
// - size guard: refuses when free disk space is under 2x the logical database
//   size (page_count x page_size); skipped only when df output is unusable
// - locking: migrations run inside BEGIN IMMEDIATE transactions (single
//   writer) and the journal is rechecked inside the lock, so concurrent
//   runners cannot double-apply; a failure rolls back journal row and all
import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const BACKUP_RETENTION = 5;
const FREE_SPACE_FACTOR = 2;

export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const database = new Database(path, { create: true });
  // Durability settings, applied on every open:
  // WAL keeps readers unblocked during writes, foreign keys are enforced,
  // and writers wait up to 5000 ms for a lock instead of failing instantly.
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");
  return database;
}

interface MigrationFile {
  name: string;
  path: string;
}

function migrationsDir(): string {
  // src/db/migrations in development; dist/migrations once bundled (the
  // Dockerfile copies them next to dist/server.js).
  const candidates = [join(import.meta.dir, "migrations"), join(import.meta.dir, "..", "src", "db", "migrations")];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`migrations directory not found near ${import.meta.dir}`);
}

export function listMigrations(dir = migrationsDir()): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, path: join(dir, name) }));
}

function ensureJournal(database: Database): void {
  database.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));");
}

export function appliedMigrations(database: Database): string[] {
  ensureJournal(database);
  return database.query<{ name: string }, []>("SELECT name FROM _migrations ORDER BY name").all().map((row) => row.name);
}

export function pendingMigrations(database: Database, dir?: string): MigrationFile[] {
  const applied = new Set(appliedMigrations(database));
  const pending = listMigrations(dir).filter((migration) => !applied.has(migration.name));
  // Migrations apply in filename order; a pending name sorting before an
  // applied one means a backfilled or renamed history, which would replay
  // out of order on the next fresh database. Refuse it.
  const highWater = appliedMigrations(database).at(-1);
  if (highWater) {
    const backfilled = pending.filter((migration) => migration.name < highWater);
    if (backfilled.length > 0) {
      throw new Error(`migrations ${backfilled.map((m) => m.name).join(", ")} sort before already-applied ${highWater}. Rename them to sort last.`);
    }
  }
  return pending;
}

export function hasUserTables(database: Database): boolean {
  const row = database
    .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'")
    .get();
  return (row?.n ?? 0) > 0;
}

export async function applyMigrations(database: Database, dir?: string): Promise<string[]> {
  const applied: string[] = [];
  for (const migration of pendingMigrations(database, dir)) {
    const sql = await Bun.file(migration.path).text();
    // Transaction control inside a migration would escape the runner's
    // transaction and could commit partial changes without a journal row.
    // Anchored at start-of-file or after a `;` so it also catches control
    // that follows another statement on the same line.
    if (/(^|;)\s*(BEGIN|COMMIT|ROLLBACK|END)\b/im.test(sql)) {
      throw new Error(`migration ${migration.name} contains transaction control (BEGIN/COMMIT/ROLLBACK); the runner owns the transaction. Remove those statements.`);
    }
    database.exec("BEGIN IMMEDIATE;");
    try {
      // Recheck inside the write lock so concurrent runners cannot both
      // apply the same migration.
      const done = database.query("SELECT 1 FROM _migrations WHERE name = ?").get(migration.name);
      if (done) {
        database.exec("ROLLBACK;");
        continue;
      }
      database.exec(sql);
      database.query("INSERT INTO _migrations (name) VALUES (?)").run(migration.name);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw new Error(`migration ${migration.name} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
    }
    applied.push(migration.name);
  }
  return applied;
}

function logicalDatabaseSize(database: Database): number {
  const pageCount = database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
  const pageSize = database.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 4096;
  return pageCount * pageSize;
}

function freeDiskBytes(path: string): number | undefined {
  const result = Bun.spawnSync(["df", "-k", path], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return undefined;
  const line = result.stdout.toString().trim().split("\n").at(-1);
  const available = line?.trim().split(/\s+/)[3];
  const kib = Number(available);
  return Number.isFinite(kib) && kib > 0 ? kib * 1024 : undefined;
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

export async function backupDatabase(database: Database, dbPath: string): Promise<string> {
  // Logical size covers WAL-resident pages that the file size misses.
  const size = logicalDatabaseSize(database);
  const backupsDir = join(dirname(dbPath), "backups");
  mkdirSync(backupsDir, { recursive: true });
  const free = freeDiskBytes(backupsDir);
  if (free !== undefined && free < size * FREE_SPACE_FACTOR) {
    throw new Error(`refusing backup: ${Math.round(free / 1024 ** 2)} MiB free, need ${Math.round((size * FREE_SPACE_FACTOR) / 1024 ** 2)} MiB (2x database size). Free disk space, then retry.`);
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const prefix = `${basename(dbPath)}.`;
  const target = join(backupsDir, `${prefix}${stamp}.sqlite`);
  database.query("VACUUM INTO ?").run(target);
  await Bun.write(`${target}.sha256`, `${await sha256File(target)}  ${basename(target)}\n`);

  // Retention touches only this database's own backups, never other files.
  const backups = readdirSync(backupsDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".sqlite") && name !== basename(target))
    .sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - (BACKUP_RETENTION - 1)))) {
    rmSync(join(backupsDir, stale), { force: true });
    rmSync(join(backupsDir, `${stale}.sha256`), { force: true });
  }
  return target;
}

// Restore is an offline operation: run it with the app stopped, then start
// the app so boot re-applies any migrations newer than the backup. Nothing
// is opened or created at the destination before the checksum verifies.
export async function restoreDatabase(backupPath: string, dbPath: string): Promise<void> {
  if (!existsSync(backupPath)) throw new Error(`backup not found: ${backupPath}`);
  const sidecar = `${backupPath}.sha256`;
  if (!existsSync(sidecar)) throw new Error(`checksum sidecar not found: ${sidecar}`);
  const expected = (await Bun.file(sidecar).text()).trim().split(/\s+/)[0];
  const digest = await sha256File(backupPath);
  if (digest !== expected) throw new Error(`backup checksum mismatch for ${backupPath}; the file is corrupt or was modified.`);
  mkdirSync(dirname(dbPath), { recursive: true });
  // Stage a fsynced copy, atomically swap it in, and only then drop WAL/SHM.
  // A failed rename leaves the previous database family fully intact; a stale
  // WAL against the swapped file is ignored by SQLite (salt mismatch).
  const temp = `${dbPath}.restore-tmp`;
  await Bun.write(temp, Bun.file(backupPath));
  const handle = openSync(temp, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temp, dbPath);
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

export async function bootDatabase(database: Database, dbPath: string): Promise<void> {
  const check = database.query<{ quick_check: string }, []>("PRAGMA quick_check(1)").get();
  if (check?.quick_check !== "ok") {
    throw new Error(`database integrity check failed for ${dbPath}: ${check?.quick_check ?? "no result"}. Restore a backup with bun db:restore.`);
  }
  // Existing data is anything with user tables, journaled or not, so a
  // database predating this tooling still gets a pre-migration backup.
  const existingData = hasUserTables(database);
  const pending = pendingMigrations(database);
  if (pending.length === 0) return;
  if (existingData) {
    const backup = await backupDatabase(database, dbPath);
    console.log(`Pre-migration backup: ${backup}`);
  }
  const applied = await applyMigrations(database);
  console.log(`Applied migrations: ${applied.join(", ")}`);
}
