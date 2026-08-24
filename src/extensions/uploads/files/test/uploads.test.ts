import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The db module opens DB_PATH at import time; point it at a scratch database
// whose directory also becomes the uploads root.
const scratch = mkdtempSync(join(tmpdir(), "uploads-test-"));
process.env.DB_PATH = join(scratch, "app.db");
const { app } = await import("../src/app");
const { sqlite } = await import("../src/db");
const { applyMigrations } = await import("../src/db/lifecycle");
const { createUser, createSession, SESSION_COOKIE } = await import("../src/lib/auth");
const {
  MAX_FILE_BYTES,
  deleteUpload,
  resolveStored,
  saveBuffer,
  sniffType,
  uploadsDir,
} = await import("../src/lib/uploads");
await applyMigrations(sqlite);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

let sessionCounter = 0;
async function freshSession(): Promise<{ userId: number; cookie: string }> {
  sessionCounter += 1;
  const user = await createUser(`up${sessionCounter}-${Date.now()}@example.com`, "password123");
  const token = await createSession(user.id);
  return { userId: user.id, cookie: `${SESSION_COOKIE}=${token}` };
}

function multipart(files: Array<{ name: string; bytes: Uint8Array; type?: string }>): FormData {
  const form = new FormData();
  for (const f of files) {
    form.append("file", new File([f.bytes as BlobPart], f.name, { type: f.type ?? "application/octet-stream" }));
  }
  return form;
}

async function upload(cookie: string, form: FormData): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/uploads", {
      method: "POST",
      headers: { cookie, origin: "http://localhost" },
      body: form,
    })
  );
}

describe("type sniffing", () => {
  it("recognizes allowed types by magic bytes and rejects others", () => {
    expect(sniffType(PNG)?.contentType).toBe("image/png");
    expect(sniffType(PDF)?.contentType).toBe("application/pdf");
    expect(sniffType(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull(); // <svg
    expect(sniffType(new Uint8Array([0x4d, 0x5a]))).toBeNull(); // PE
  });
});

describe("resolveStored", () => {
  it("accepts content-addressed names and rejects traversal or arbitrary names", () => {
    const hex = "a".repeat(64);
    expect(resolveStored(`${hex}.png`)).toContain(uploadsDir());
    expect(resolveStored("../secret.png")).toBeNull();
    expect(resolveStored("evil.png")).toBeNull();
    expect(resolveStored(`${hex}.png/../../etc/passwd`)).toBeNull();
    expect(resolveStored(`${hex}`)).toBeNull();
  });
});

describe("saveBuffer", () => {
  it("stores content-addressed and dedupes identical bytes", async () => {
    const { userId } = await freshSession();
    const a = await saveBuffer(PNG, "one.png", userId);
    const b = await saveBuffer(PNG, "two.png", userId);
    expect(a.storedName).toBe(b.storedName);
    expect(a.storedName).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(existsSync(resolveStored(a.storedName)!)).toBe(true);
  });

  it("rejects empty, oversize, and unknown-type buffers", async () => {
    const { userId } = await freshSession();
    await expect(saveBuffer(new Uint8Array(0), "empty.png", userId)).rejects.toThrow("empty");
    await expect(saveBuffer(new Uint8Array(MAX_FILE_BYTES + 1).fill(0x89), "big.png", userId)).rejects.toThrow(
      "exceeds"
    );
    await expect(saveBuffer(new Uint8Array([1, 2, 3, 4, 5]), "mystery.bin", userId)).rejects.toThrow(
      "unsupported"
    );
  });
});

describe("routes", () => {
  it("requires a session", async () => {
    const res = await app.fetch(
      new Request("http://localhost/uploads", { headers: { "x-forwarded-for": "10.9.9.9" } })
    );
    expect(res.status).toBe(401);
  });

  it("blocks cross-origin uploads (CSRF)", async () => {
    const { cookie } = await freshSession();
    const res = await app.fetch(
      new Request("http://localhost/uploads", {
        method: "POST",
        headers: { cookie, origin: "https://evil.example" },
        body: multipart([{ name: "a.png", bytes: PNG }]),
      })
    );
    expect(res.status).toBe(403);
  });

  it("uploads, lists, downloads (as attachment), and deletes, owner-scoped", async () => {
    const { cookie } = await freshSession();
    const res = await upload(cookie, multipart([{ name: "photo.png", bytes: PNG }]));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { saved: Array<{ id: number; contentType: string }>; rejected: unknown[] };
    expect(body.saved.length).toBe(1);
    expect(body.rejected.length).toBe(0);
    const id = body.saved[0]!.id;

    const list = await app.fetch(new Request("http://localhost/uploads", { headers: { cookie } }));
    expect(((await list.json()) as { uploads: unknown[] }).uploads.length).toBe(1);

    const download = await app.fetch(new Request(`http://localhost/uploads/${id}`, { headers: { cookie } }));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(download.headers.get("content-disposition")).toContain("attachment");

    // A different user cannot see or fetch it.
    const other = await freshSession();
    const otherGet = await app.fetch(
      new Request(`http://localhost/uploads/${id}`, { headers: { cookie: other.cookie } })
    );
    expect(otherGet.status).toBe(404);

    const del = await app.fetch(
      new Request(`http://localhost/uploads/${id}`, {
        method: "DELETE",
        headers: { cookie, origin: "http://localhost" },
      })
    );
    expect(del.status).toBe(200);
  });

  it("rejects a disallowed type in multipart with a reason", async () => {
    const { cookie } = await freshSession();
    const res = await upload(cookie, multipart([{ name: "script.svg", bytes: new Uint8Array([0x3c, 0x73, 0x76, 0x67]) }]));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { saved: unknown[]; rejected: Array<{ reason: string }> };
    expect(body.saved.length).toBe(0);
    expect(body.rejected[0]!.reason).toContain("unsupported");
  });

  it("caps the number of files per request", async () => {
    const { cookie } = await freshSession();
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.png`, bytes: PNG }));
    const res = await upload(cookie, multipart(many));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("Too many");
  });
});

describe("blob lifecycle", () => {
  it("keeps the blob while another row references it, deletes when last goes", async () => {
    const first = await freshSession();
    const second = await freshSession();
    const a = await saveBuffer(PDF, "a.pdf", first.userId);
    const b = await saveBuffer(PDF, "b.pdf", second.userId);
    expect(a.storedName).toBe(b.storedName);
    const path = resolveStored(a.storedName)!;

    expect(await deleteUpload(a.id, first.userId)).toBe(true);
    expect(existsSync(path)).toBe(true); // second row still references it
    expect(await deleteUpload(b.id, second.userId)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
