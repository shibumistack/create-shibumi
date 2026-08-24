# Admin extension

Installed by `bun run shibumi add admin`. Needs the auth extension. This project owns every file below.

## Files

- `src/lib/admin.ts`: the `ADMIN_EMAILS` allowlist check (`isAdmin`), the user read model (`listUsers`), and `deleteUser`.
- `src/routes/admin.ts`: server-rendered panel mounted at `/admin` (no client JS; actions are form POSTs).
- `public/admin.css`: small utilitarian styles reusing the template's paper/ink/persimmon tokens.
- `test/admin.test.ts`: access-control, CSRF, and delete coverage.

## Who is an admin

Admins are the emails in the `ADMIN_EMAILS` environment variable (comma-separated, case-insensitive), validated in `src/env.ts`. There is no database flag and no bootstrap step: set the variable and that account is an admin. With `ADMIN_EMAILS` empty, no one is an admin and `/admin` is locked.

## Endpoints

- `GET /admin` → HTML user table (id, email, created, session count, upload count when the uploads extension is installed).
- `POST /admin/users/:id/delete` → deletes a user (cascades to sessions, login tokens, and upload rows via their foreign keys); refuses self-deletion. CSRF protected.

Signed-out visitors get a 401 page, signed-in non-admins a 403 page.

## Notes

- Deleting a user does not sweep stored upload blobs on disk; the uploads extension owns that lifecycle. Clear `<db-dir>/uploads` separately if needed.
- The panel is intentionally minimal. Add columns or actions in `src/routes/admin.ts`; keep every mutation a CSRF-protected POST and every route behind the allowlist gate.

## Removal

`bun run shibumi remove admin` deletes the code and reverses the edits. Remove `admin` before removing `auth`. Remove the `ADMIN_EMAILS` variable from the environment when no longer needed.
