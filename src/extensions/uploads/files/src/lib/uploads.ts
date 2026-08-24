// Upload storage: validate, content-address, persist, serve, delete.
// Installed by `bun run shibumi add uploads` (needs the auth extension).
// This project owns the file. Full guide: agents/uploads.md.
//
// Invariants:
// - A file's type is decided by sniffing its leading bytes, never by the
//   client-supplied filename or Content-Type. Anything not on the allowlist
//   is rejected.
// - On-disk names are sha256(content) + the sniffed extension, so a filename
//   can never contain a path separator or traversal segment, and identical
//   bytes are stored once.
// - Bytes live under <db-dir>/uploads, i.e. the persistent /data volume in the
//   container; metadata lives in app.db. The two are reconciled on delete.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { uploads } from "../db/schema-uploads";
import { loadEnv } from "../env";
// Editable knobs live in config/uploads.yaml; Bun bundles the parsed values
// into the image at build time. Edit that file and re-deploy to change limits.
import rawUploadsConfig from "../config/uploads.yaml";

// A bad edit (missing, non-numeric, non-positive, non-integer) throws here at
// module load, so the container fails its health check and the previous
// deployment stays live rather than serving with a disabled limit.
function positiveInt(config: Record<string, unknown>, key: string): number {
  const value = config[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`uploads config: ${key} must be a positive integer (config/uploads.yaml)`);
  }
  return value;
}

const uploadsConfig = (rawUploadsConfig ?? {}) as Record<string, unknown>;
const MIB = 1024 * 1024;

export const MAX_FILE_BYTES = positiveInt(uploadsConfig, "max_file_mib") * MIB;
export const MAX_FILES_PER_REQUEST = positiveInt(uploadsConfig, "max_files_per_request");
// Per-user ceiling on total stored bytes, so a self-registered account cannot
// fill the volume. Dedup means shared blobs are counted per referencing row,
// which is the conservative (higher) number.
export const USER_QUOTA_BYTES = positiveInt(uploadsConfig, "user_quota_mib") * MIB;
export const UPLOAD_RATE_LIMIT = positiveInt(uploadsConfig, "rate_limit_per_15min");
export const UPLOAD_RATE_WINDOW_MS = 15 * 60 * 1000;

interface AllowedType {
  contentType: string;
  extension: string;
  matches: (bytes: Uint8Array) => boolean;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

// Allowlist by magic bytes. Extend deliberately; every entry must have a
// signature so type is proven, not asserted.
const ALLOWED_TYPES: AllowedType[] = [
  { contentType: "image/png", extension: "png", matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { contentType: "image/jpeg", extension: "jpg", matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { contentType: "image/gif", extension: "gif", matches: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  {
    contentType: "image/webp",
    extension: "webp",
    matches: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8),
  },
  { contentType: "application/pdf", extension: "pdf", matches: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]) },
];

export function sniffType(bytes: Uint8Array): AllowedType | null {
  return ALLOWED_TYPES.find((type) => type.matches(bytes)) ?? null;
}

export function uploadsDir(): string {
  const env = loadEnv();
  return join(dirname(env.DB_PATH), "uploads");
}

// Resolve a stored name to an absolute path, refusing anything that is not a
// bare content-addressed name or that escapes the uploads directory.
const STORED_NAME = /^[a-f0-9]{64}\.[a-z0-9]+$/;
export function resolveStored(storedName: string): string | null {
  if (!STORED_NAME.test(storedName)) return null;
  const base = resolve(uploadsDir());
  const target = resolve(base, storedName);
  if (target !== join(base, storedName) || !target.startsWith(base + sep)) return null;
  return target;
}

export interface StoredUpload {
  id: number;
  storedName: string;
  originalName: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface RejectedUpload {
  originalName: string;
  reason: string;
}

export interface SaveResult {
  saved: StoredUpload[];
  rejected: RejectedUpload[];
}

function sanitizeOriginalName(name: string): string {
  // Kept for display only; never used on disk. Strip path separators and
  // control chars (incl. CR/LF so it is safe in a Content-Disposition header),
  // keep ordinary filename characters like ".", bound the length.
  const base =
    name
      .replace(/[/\\]/g, "")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .trim() || "file";
  return base.slice(0, 255);
}

// Validates and stores one already-read buffer. Exported for direct testing.
export async function saveBuffer(
  bytes: Uint8Array,
  originalName: string,
  userId: number
): Promise<StoredUpload> {
  if (bytes.length === 0) throw new Error("empty file");
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
  const type = sniffType(bytes);
  if (!type) throw new Error("unsupported file type");

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storedName = `${sha256}.${type.extension}`;
  const target = resolveStored(storedName);
  if (!target) throw new Error("could not resolve a safe storage path");

  const dir = uploadsDir();
  mkdirSync(dir, { recursive: true });
  // The storage root must be a real directory, never a symlink another
  // principal could repoint outside the volume.
  if (lstatSync(dir).isSymbolicLink()) throw new Error("uploads directory is a symlink");
  // Content-addressed: if the bytes already exist on disk, reuse them.
  // Otherwise write to a unique temp file and atomically rename into place,
  // so a crash mid-write never leaves a partial blob under the final name.
  if (!existsSync(target)) {
    const tmp = `${target}.tmp-${randomUUID()}`;
    try {
      await Bun.write(tmp, bytes);
      renameSync(tmp, target);
    } finally {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    }
  }

  const originalNameSafe = sanitizeOriginalName(originalName);
  const rows = await db
    .insert(uploads)
    .values({
      storedName,
      originalName: originalNameSafe,
      contentType: type.contentType,
      size: bytes.length,
      sha256,
      userId,
    })
    .returning();
  const row = rows[0]!;
  return {
    id: row.id,
    storedName: row.storedName,
    originalName: row.originalName,
    contentType: row.contentType,
    size: row.size,
    sha256: row.sha256,
  };
}

export async function userUsageBytes(userId: number): Promise<number> {
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${uploads.size}), 0)` })
    .from(uploads)
    .where(eq(uploads.userId, userId));
  return Number(row[0]?.total ?? 0);
}

// Serialize a user's uploads so the quota read-modify-write cannot interleave
// across concurrent requests (single-process container). Each user gets a
// promise chain; entries drop out once the chain drains.
const userLocks = new Map<number, Promise<unknown>>();
export function saveFiles(files: File[], userId: number): Promise<SaveResult> {
  const run = (userLocks.get(userId) ?? Promise.resolve()).then(
    () => saveFilesLocked(files, userId),
    () => saveFilesLocked(files, userId)
  );
  userLocks.set(userId, run);
  void run.finally(() => {
    if (userLocks.get(userId) === run) userLocks.delete(userId);
  });
  return run;
}

async function saveFilesLocked(files: File[], userId: number): Promise<SaveResult> {
  if (files.length === 0) throw new Error("no files provided");
  if (files.length > MAX_FILES_PER_REQUEST) {
    throw new Error(`too many files (max ${MAX_FILES_PER_REQUEST} per request)`);
  }
  const saved: StoredUpload[] = [];
  const rejected: RejectedUpload[] = [];
  // Serialized above, so this snapshot is stable for the batch.
  let usage = await userUsageBytes(userId);
  for (const file of files) {
    const originalName = sanitizeOriginalName(file.name || "file");
    try {
      // Enforce the size limit before buffering the whole file.
      if (file.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
      if (usage + file.size > USER_QUOTA_BYTES) throw new Error("storage quota exceeded");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const stored = await saveBuffer(bytes, originalName, userId);
      usage += stored.size;
      saved.push(stored);
    } catch (error) {
      rejected.push({ originalName, reason: error instanceof Error ? error.message : "rejected" });
    }
  }
  return { saved, rejected };
}

export async function listUploads(userId: number): Promise<StoredUpload[]> {
  const rows = await db.select().from(uploads).where(eq(uploads.userId, userId));
  return rows.map((row) => ({
    id: row.id,
    storedName: row.storedName,
    originalName: row.originalName,
    contentType: row.contentType,
    size: row.size,
    sha256: row.sha256,
  }));
}

export async function getUpload(id: number, userId: number): Promise<(StoredUpload & { path: string }) | null> {
  const rows = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, id), eq(uploads.userId, userId)));
  const row = rows[0];
  if (!row) return null;
  const path = resolveStored(row.storedName);
  if (!path) return null;
  return {
    id: row.id,
    storedName: row.storedName,
    originalName: row.originalName,
    contentType: row.contentType,
    size: row.size,
    sha256: row.sha256,
    path,
  };
}

export async function deleteUpload(id: number, userId: number): Promise<boolean> {
  const rows = await db
    .delete(uploads)
    .where(and(eq(uploads.id, id), eq(uploads.userId, userId)))
    .returning();
  const row = rows[0];
  if (!row) return false;
  // Only remove the bytes when no other row (any user) references the same
  // content-addressed blob.
  const others = await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.storedName, row.storedName));
  if (others.length === 0) {
    const path = resolveStored(row.storedName);
    if (path && existsSync(path)) await Bun.file(path).delete();
  }
  return true;
}
