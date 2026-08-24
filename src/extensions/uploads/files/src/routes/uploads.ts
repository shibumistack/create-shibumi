// Upload routes, mounted at /uploads by the installer. Every route requires a
// session (uploads has no unauthenticated endpoints); CSRF covers mutations.
// Files are owned by the uploading user; serving is scoped to the owner.
import { Hono } from "hono";
import type { Context } from "hono";
import { csrf } from "hono/csrf";
import { rateLimit, requireAuth, type AuthEnv } from "../lib/auth";
import {
  MAX_FILES_PER_REQUEST,
  MAX_FILE_BYTES,
  deleteUpload,
  getUpload,
  listUploads,
  saveFiles,
} from "../lib/uploads";

const UPLOAD_RATE_WINDOW_MS = 15 * 60 * 1000;
const UPLOAD_RATE_LIMIT = 30; // POST /uploads calls per user per window

export const uploadRoutes = new Hono<AuthEnv>();

// CSRF first (refuse cross-origin mutations before any session work), then a
// required session. Two middleware registrations, so the mounted surface
// carries two `ALL /uploads/*` entries.
uploadRoutes.use(csrf());
uploadRoutes.use(requireAuth);

function idParam(c: Context): number | null {
  const raw = c.req.param("id") ?? "";
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

uploadRoutes.post("/", async (c) => {
  // Keyed on the authenticated user, so it needs no forwarded-IP trust.
  if (!rateLimit(`uploads:${c.get("user").id}`, UPLOAD_RATE_LIMIT, UPLOAD_RATE_WINDOW_MS)) {
    return c.json({ error: "Too many uploads. Try again later." }, 429);
  }
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "Expected multipart/form-data." }, 400);
  }
  const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return c.json({ error: "Attach at least one file in the 'file' field." }, 400);
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return c.json({ error: `Too many files (max ${MAX_FILES_PER_REQUEST}).` }, 400);
  }
  const result = await saveFiles(files, c.get("user").id);
  // All rejected and nothing saved is a client error; a partial success still
  // reports which files were refused and why.
  const status = result.saved.length === 0 ? 400 : 201;
  return c.json(result, status);
});

uploadRoutes.get("/", async (c) => {
  return c.json({ uploads: await listUploads(c.get("user").id) });
});

uploadRoutes.get("/:id", async (c) => {
  const id = idParam(c);
  if (id === null) return c.json({ error: "Invalid id." }, 400);
  const upload = await getUpload(id, c.get("user").id);
  if (!upload) return c.json({ error: "Not found." }, 404);
  const file = Bun.file(upload.path);
  if (!(await file.exists())) return c.json({ error: "File is missing on disk." }, 410);
  return new Response(file, {
    headers: {
      "content-type": upload.contentType,
      "content-length": String(upload.size),
      // Never render untrusted uploads inline; force a download.
      "content-disposition": `attachment; filename="${upload.originalName.replace(/"/g, "")}"`,
      "cache-control": "private, no-store",
    },
  });
});

uploadRoutes.delete("/:id", async (c) => {
  const id = idParam(c);
  if (id === null) return c.json({ error: "Invalid id." }, 400);
  const removed = await deleteUpload(id, c.get("user").id);
  if (!removed) return c.json({ error: "Not found." }, 404);
  return c.json({ ok: true });
});

export const UPLOAD_LIMITS = { maxFiles: MAX_FILES_PER_REQUEST, maxBytes: MAX_FILE_BYTES };
