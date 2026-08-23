# Auth extension

Installed by `bun run shibumi add auth`. This project owns every file below; edit them like any other source.

## Files

- `src/lib/auth.ts`: users, sessions, login tokens, rate limiter, `requireAuth` / `optionalAuth` middleware, and the login-link delivery seam.
- `src/routes/auth.ts`: JSON endpoints mounted at `/auth`.
- `src/db/schema-auth.ts`: Drizzle schema for `users`, `sessions`, `login_tokens`.
- `src/db/migrations/<n>_auth.sql`: the tables, numbered into this project's migration stream at install time.
- `test/auth.test.ts`: register/login/session/login-link/CSRF/rate-limit coverage.

## Endpoints

- `POST /auth/register` `{ email, password }` → 201, sets session cookie. Password 8 to 128 chars, hashed with `Bun.password` (argon2id).
- `POST /auth/login` `{ email, password }` → 200 or a uniform 401. Rate limited per IP + email (10 per 15 min).
- `POST /auth/login-link` `{ email }` → uniform 200 whether or not the account exists (no enumeration). Rate limited per IP (5 per 15 min).
- `GET /auth/verify?token=...` → consumes the single-use token (15 min expiry), sets session cookie, redirects to `/`.
- `POST /auth/logout` → destroys the session, clears the cookie.
- `GET /auth/me` → `{ user }` or `{ user: null }`.

## Session model

- Cookie `session`: HttpOnly, Secure, SameSite=Lax, Path=/, 7-day expiry. Browsers treat localhost as a secure context, so Secure works in development.
- The database stores sha256 hashes of session and login tokens, never the tokens. A leaked database cannot mint logins.
- Protect routes with `requireAuth` (401 when signed out) or `optionalAuth`:

```ts
import { requireAuth } from "./lib/auth";
app.use("/account/*", requireAuth);
```

## Honeypot

`register`, `login`, and `login-link` accept an optional decoy field named `website`. Real clients omit it (or send it empty); render it in HTML forms as a visually hidden input. A non-empty value marks the request as a bot: the response stays plausible (fake 201, uniform 401, uniform 200) while no account, session, or token is created.

## CSRF and rate limiting

- `hono/csrf` runs on every `/auth` mutation (Origin check on form-shaped posts); cross-origin JSON is stopped by the browser preflight.
- The rate limiter is in-memory and per-process. That matches the single-container deployment; counts reset on restart. Replace it before scaling to multiple processes.
- Rate keys use `x-forwarded-for`, which is only trustworthy behind the deployment proxy. Directly exposed apps share one bucket.

## Wiring login-link delivery

`deliverLoginLink` in `src/lib/auth.ts` logs the URL in development and throws in production until wired. With the email extension installed:

```ts
import { sendEmail } from "./email";

export async function deliverLoginLink(email: string, url: string): Promise<void> {
  await sendEmail({
    to: email,
    subject: "Your login link",
    html: `<p><a href="${url}">Log in</a> (expires in 15 minutes, single use).</p>`,
  });
}
```

## Removal

`bun run shibumi remove auth` deletes the installed code and reverses the edits. Tables are never dropped by tooling; when the migration already ran somewhere, drop manually with:

```sql
DROP TABLE login_tokens; DROP TABLE sessions; DROP TABLE users;
```
