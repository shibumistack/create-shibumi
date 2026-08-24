# Admin extension

Installed by `bun run shibumi add admin`. Needs the auth extension. This project owns every file below.

## Files

- `src/lib/admin.ts`: the `ADMIN_EMAILS` allowlist check (`isAdmin`), the user read model (`listUsers`), and `deleteUser`.
- `src/routes/admin.ts`: server-rendered panel mounted at `/admin` (no client JS; actions are form POSTs).
- `public/admin.css`: small utilitarian styles reusing the template's paper/ink/persimmon tokens.
- `test/admin.test.ts`: access-control, CSRF, and delete coverage.

## Who is an admin

Admins are the emails in the `ADMIN_EMAILS` environment variable (comma-separated, case-insensitive), validated in `src/env.ts`. There is no database flag: set the variable and that account is an admin. With `ADMIN_EMAILS` empty, no one is an admin and `/admin` is locked.

Because access is granted by email, the auth extension **reserves** every `ADMIN_EMAILS` address from self-service password registration (a `403` at `/auth/register`), so an attacker cannot register the admin address before you. Create the admin account by one of:

- **Login link** (proves inbox control): request `/auth/login-link` for the admin email once the email extension is wired.
- **Console seed** before exposing the app: `bun -e 'import { createUser } from "./src/lib/auth"; await createUser("you@example.com", process.env.SEED_PW!)'` with `SEED_PW` set in the environment.

Set `ADMIN_EMAILS` before the app is publicly reachable.

## Endpoints

- `GET /admin` → HTML user table (id, email, created, session count, upload count when the uploads extension is installed).
- `POST /admin/users/:id/delete` → deletes a user (cascades to sessions, login tokens, and upload rows via their foreign keys); refuses self-deletion. CSRF protected.

Signed-out visitors get a 401 page, signed-in non-admins a 403 page.

## Notes

- Deleting a user does not sweep stored upload blobs on disk; the uploads extension owns that lifecycle. Clear `<db-dir>/uploads` separately if needed.
- The panel is intentionally minimal. Add columns or actions in `src/routes/admin.ts`; keep every mutation a CSRF-protected POST and every route behind the allowlist gate.

## Removal

`bun run shibumi remove admin` deletes the code and reverses the edits. Remove `admin` before removing `auth`. Remove the `ADMIN_EMAILS` variable from the environment when no longer needed.
