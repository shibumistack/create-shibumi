
## Auth (added via shibumi add auth)

### Password auth
- Register: `POST /auth/register` with `{ email, password }`
- Login: `POST /auth/login` with `{ email, password }`
- Passwords hashed with `Bun.password.hash()`: never store plain text
- Sessions stored in `data/auth.db`: add to `.gitignore`

### Magic link auth
- Request: `POST /auth/magic-request` with `{ email }`
- Verify: `GET /auth/magic-verify?token=...` (from email link)
- Tokens expire after 15 minutes, single use
- In production, send the link via the email extension

### Middleware
- `authMiddleware`: required auth, redirects to `/auth/login`
- `optionalAuth`: attaches user if logged in, doesn't block
- Protected routes: `app.use("/protected/*", authMiddleware)`

### Session
- `src/lib/session.ts`: all session logic lives here
- Use `createSession()` / `destroySession()`, never set cookies directly
- `validateSession()` returns userId or null

### Files
- `src/lib/session.ts`: session + user management
- `src/middleware/auth.ts`: auth middleware
- `src/routes/auth.ts`: login/register/magic-link routes
- `src/db/schema.auth.ts`: Drizzle schema (if using SSR template)
