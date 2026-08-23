import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMigrations,
  appliedMigrations,
  backupDatabase,
  bootDatabase,
  listMigrations,
  pendingMigrations,
  restoreDatabase,
  openDatabase,
} from "../src/db/lifecycle";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "db-test-"));
  dbPath = join(dir, "app.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("migrations", () => {
  it("applies every migration to a fresh database and answers representative queries", async () => {
    const db = openDatabase(dbPath);
    expect(pendingMigrations(db).length).toBe(listMigrations().length);
    const applied = await applyMigrations(db);
    expect(applied).toEqual(listMigrations().map((m) => m.name));
    expect(pendingMigrations(db)).toEqual([]);

    const titles = db.query<{ title: string }, []>("SELECT title FROM notes ORDER BY id").all();
    expect(titles.map((row) => row.title)).toContain("It persists.");
    db.query("INSERT INTO notes (title) VALUES (?)").run("second");
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM notes").get()?.n).toBe(2);
  });

  it("is idempotent and journaled", async () => {
    const db = openDatabase(dbPath);
    await applyMigrations(db);
    expect(await applyMigrations(db)).toEqual([]);
    expect(appliedMigrations(db)).toEqual(listMigrations().map((m) => m.name));
  });

  it("applies durability pragmas on open", () => {
    const db = openDatabase(dbPath);
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
  });
});

describe("backup and restore", () => {
  it("backs up with a checksum sidecar and restores after data loss", async () => {
    const db = openDatabase(dbPath);
    await applyMigrations(db);
    db.query("INSERT INTO notes (title) VALUES (?)").run("keep me");

    const backup = await backupDatabase(db, dbPath);
    expect(existsSync(backup)).toBe(true);
    expect(existsSync(`${backup}.sha256`)).toBe(true);

    db.query("DELETE FROM notes").run();
    db.close();

    await restoreDatabase(backup, dbPath);
    const restored = openDatabase(dbPath);
    const titles = restored.query<{ title: string }, []>("SELECT title FROM notes").all();
    expect(titles.map((row) => row.title)).toContain("keep me");
  });

  it("rejects a corrupted backup by checksum", async () => {
    const db = openDatabase(dbPath);
    await applyMigrations(db);
    const backup = await backupDatabase(db, dbPath);
    db.close();
    const raw = new Uint8Array(await Bun.file(backup).arrayBuffer());
    raw[100] = raw[100]! ^ 0xff;
    await Bun.write(backup, raw);
    await expect(restoreDatabase(backup, dbPath)).rejects.toThrow("checksum mismatch");
  });

  it("keeps only the newest five backups", async () => {
    const db = openDatabase(dbPath);
    await applyMigrations(db);
    for (let index = 0; index < 7; index += 1) {
      await backupDatabase(db, dbPath);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 5));
    }
    const backups = readdirSync(join(dir, "backups")).filter((name) => name.endsWith(".sqlite"));
    expect(backups.length).toBe(5);
  });
});

describe("boot ordering", () => {
  it("backs up before applying pending migrations to an existing database", async () => {
    const db = openDatabase(dbPath);
    // Simulate a database predating this tooling: user data exists but no
    // journal. Boot must back it up before migrating.
    db.exec("CREATE TABLE legacy (id INTEGER PRIMARY KEY);");
    db.exec("INSERT INTO legacy (id) VALUES (1);");
    await bootDatabase(db, dbPath);
    expect(readdirSync(join(dir, "backups")).some((name) => name.endsWith(".sqlite"))).toBe(true);
    expect(pendingMigrations(db)).toEqual([]);
  });

  it("does not back up a brand-new database", async () => {
    const db = openDatabase(dbPath);
    await bootDatabase(db, dbPath);
    expect(existsSync(join(dir, "backups"))).toBe(false);
    expect(pendingMigrations(db)).toEqual([]);
  });

  it("rolls back a failing migration and keeps the journal clean", async () => {
    const db = openDatabase(dbPath);
    await applyMigrations(db);
    const before = appliedMigrations(db);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const extraDir = join(dir, "migrations-extra");
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(join(extraDir, "9998_good.sql"), "CREATE TABLE extra_ok (id INTEGER PRIMARY KEY);");
    writeFileSync(join(extraDir, "9999_broken.sql"), "CREATE TABLE broken (;");
    await expect(applyMigrations(db, extraDir)).rejects.toThrow("9999_broken.sql failed and was rolled back");
    // The good migration before the broken one committed; the broken one
    // left no journal row and no partial objects.
    expect(appliedMigrations(db)).toEqual([...before, "9998_good.sql"].sort());
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'broken'").get()).toBeNull();
  });
});

describe("migration guards", () => {
  it("rejects migrations containing transaction control", async () => {
    const db = openDatabase(dbPath);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const extraDir = join(dir, "migrations-tx");
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(join(extraDir, "0001_tx.sql"), "BEGIN;\nCREATE TABLE x (id INTEGER);\nCOMMIT;");
    await expect(applyMigrations(db, extraDir)).rejects.toThrow("transaction control");
  });

  it("rejects backfilled migrations sorting before applied ones", async () => {
    const db = openDatabase(dbPath);
    await applyMigrations(db);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const extraDir = join(dir, "migrations-backfill");
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(join(extraDir, "0000_early.sql"), "CREATE TABLE early (id INTEGER);");
    expect(() => pendingMigrations(db, extraDir)).toThrow("Rename them to sort last");
  });

  it("retention never touches unrelated files in the backups directory", async () => {
    const db = openDatabase(dbPath);
    await applyMigrations(db);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "backups"), { recursive: true });
    writeFileSync(join(dir, "backups", "unrelated.sqlite"), "not ours");
    for (let index = 0; index < 7; index += 1) {
      await backupDatabase(db, dbPath);
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 5));
    }
    const files = readdirSync(join(dir, "backups"));
    expect(files).toContain("unrelated.sqlite");
    expect(files.filter((name) => name.startsWith("app.db.") && name.endsWith(".sqlite")).length).toBe(5);
  });
});
