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
- Limits live in `src/config/uploads.yaml` (bundled at build): `max_file_mib` (default 5), `max_files_per_request` (5), `user_quota_mib` (100), `rate_limit_per_15min` (30). `src/lib/uploads.ts` validates them at startup and refuses to boot on a bad value. Edit the YAML and re-deploy to change a limit. The oversize and quota checks run before each file is buffered.
- Type sniffing matches leading magic bytes only, so a crafted polyglot could carry a valid header. That is why serving forces `attachment` + `nosniff` and never renders inline; do not weaken that (see below). Re-encode images if you need stronger guarantees.
- On-disk name is `sha256(content).<sniffed-ext>`, so it can never contain a path separator or traversal segment, and identical bytes are stored once. The original filename is kept as display metadata only, sanitized.
- Bytes live under `<db-dir>/uploads` (derived from `DB_PATH`, so the container's `/data` volume); metadata is the `uploads` table.
- `resolveStored` rejects any name that is not a bare content-addressed name or that would escape the uploads directory; serving reads only through it.

## Request size

Installing uploads raises `maxRequestBodySize` in `src/server.ts` to a fixed 55 MiB. That is the hard server ceiling and is generous headroom over the default limits; if you raise `max_file_mib` x `max_files_per_request` above ~55 MiB in the config, raise this server value to match or the server rejects the body first. Removal restores 1 MiB. Because that ceiling admits large bodies, the auth extension caps its own JSON routes by an actual-bytes read independently; keep that guard on any small-body route you add.

## Serving untrusted files

Downloads are forced (`attachment`) and owner-scoped by default. Do not switch to inline rendering for user-supplied files without a strict `Content-Security-Policy` and a separate origin; an inline HTML or SVG upload is stored XSS otherwise.

## Removal

`bun run shibumi remove uploads` deletes the code and reverses the edits (including the `maxRequestBodySize` bump). Remove `uploads` before removing `auth`. The `uploads` table and stored files are never touched by tooling:

```sql
DROP TABLE uploads;
```
Then clear `<db-dir>/uploads` if you no longer need the files.
