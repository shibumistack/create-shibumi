# Uploads extension

Installed by `bun run shibumi add uploads`. Needs the auth extension (every route requires a session). This project owns every file below.

## Files

- `src/lib/uploads.ts`: validation, content-addressed storage, listing, owner-scoped retrieval, deletion.
- `src/routes/uploads.ts`: JSON + file endpoints mounted at `/uploads`.
- `src/db/schema-uploads.ts`: Drizzle schema for the `uploads` metadata table.
- `src/db/migrations/<n>_uploads.sql`: the table, numbered into this project's migration stream at install time.
- `test/uploads.test.ts`: validation, storage, serving, deletion, and traversal-safety coverage.

## Endpoints (all require a session)

- `POST /uploads` multipart form, field `file` (repeatable) → `{ saved, rejected }`. 201 when anything saved, 400 when everything was rejected. CSRF protected.
- `GET /uploads` → `{ uploads }` for the current user.
- `GET /uploads/:id` → the bytes, owner-scoped, `Content-Disposition: attachment` (never inline), `Cache-Control: private, no-store`.
- `DELETE /uploads/:id` → removes the row; the blob is deleted only when no other row references it. CSRF protected.

## Validation and storage

- Type is decided by sniffing magic bytes, never the client filename or `Content-Type`. Allowlist: PNG, JPEG, GIF, WebP, PDF. Extend `ALLOWED_TYPES` in `src/lib/uploads.ts`; every entry must carry a byte signature.
- Limits: 10 MiB per file (`MAX_FILE_BYTES`), 5 files per request (`MAX_FILES_PER_REQUEST`). The oversize check runs before the file is buffered.
- On-disk name is `sha256(content).<sniffed-ext>`, so it can never contain a path separator or traversal segment, and identical bytes are stored once. The original filename is kept as display metadata only, sanitized.
- Bytes live under `<db-dir>/uploads` (derived from `DB_PATH`, so the container's `/data` volume); metadata is the `uploads` table.
- `resolveStored` rejects any name that is not a bare content-addressed name or that would escape the uploads directory; serving reads only through it.

## Request size

Installing uploads raises `maxRequestBodySize` in `src/server.ts` to 55 MiB (5 x 10 MiB plus multipart overhead). Removal restores 1 MiB. Adjust both the server value and the per-file/per-request limits together if you change the caps.

## Serving untrusted files

Downloads are forced (`attachment`) and owner-scoped by default. Do not switch to inline rendering for user-supplied files without a strict `Content-Security-Policy` and a separate origin; an inline HTML or SVG upload is stored XSS otherwise.

## Removal

`bun run shibumi remove uploads` deletes the code and reverses the edits (including the `maxRequestBodySize` bump). Remove `uploads` before removing `auth`. The `uploads` table and stored files are never touched by tooling:

```sql
DROP TABLE uploads;
```
Then clear `<db-dir>/uploads` if you no longer need the files.
