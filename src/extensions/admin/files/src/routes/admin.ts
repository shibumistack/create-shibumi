// Admin panel, mounted at /admin by the installer. Server-rendered HTML, no
// client JS: actions are plain form POSTs. Every route requires a session and
// an email on the ADMIN_EMAILS allowlist; CSRF covers the mutations.
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE, csrfOptions, sessionUser, type AuthUser } from "../lib/auth";
import { deleteUser, isAdmin, listUsers, type AdminUserRow } from "../lib/admin";

type AdminEnv = { Variables: { user: AuthUser } };

export const adminRoutes = new Hono<AdminEnv>();

adminRoutes.use(csrf(csrfOptions()));
// Session + allowlist gate. Not `requireAuth`: admins get a 403 page, signed-out
// visitors a 401, both as HTML rather than JSON.
adminRoutes.use(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await sessionUser(token) : null;
  if (!user) return c.html(page("Sign in required", "<p>Sign in to reach the admin panel.</p>"), 401);
  if (!isAdmin(user.email)) return c.html(page("Forbidden", "<p>This account is not an administrator.</p>"), 403);
  c.set("user", user);
  await next();
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/public/style.css" />
    <link rel="stylesheet" href="/public/admin.css" />
    <!-- Self-hosted so it runs under the app's script-src 'self' CSP; an
         inline handler would be blocked. -->
    <script src="/public/admin.js" defer></script>
  </head>
  <body>
    <main class="admin">
      <h1>${escapeHtml(title)}</h1>
      ${body}
    </main>
  </body>
</html>
`;
}

function usersTable(rows: AdminUserRow[], self: number): string {
  if (rows.length === 0) return "<p>No users yet.</p>";
  const showUploads = rows.some((row) => row.uploads !== null);
  const head = `<tr><th>ID</th><th>Email</th><th>Created</th><th>Sessions</th>${
    showUploads ? "<th>Uploads</th>" : ""
  }<th></th></tr>`;
  const body = rows
    .map((row) => {
      const uploads = showUploads ? `<td>${row.uploads ?? 0}</td>` : "";
      const action =
        row.id === self
          ? `<td class="muted">you</td>`
          : `<td><form method="post" action="/admin/users/${row.id}/delete" data-confirm="Delete ${escapeHtml(
              row.email
            )}?"><button type="submit" class="danger">Delete</button></form></td>`;
      return `<tr><td>${row.id}</td><td>${escapeHtml(row.email)}</td><td>${escapeHtml(
        row.createdAt
      )}</td><td>${row.sessions}</td>${uploads}${action}</tr>`;
    })
    .join("");
  return `<table>${head}${body}</table>`;
}

adminRoutes.get("/", (c) => {
  const rows = listUsers();
  return c.html(
    page(
      "Users",
      `<p class="muted">${rows.length} account${rows.length === 1 ? "" : "s"}.</p>${usersTable(
        rows,
        c.get("user").id
      )}`
    )
  );
});

adminRoutes.post("/users/:id/delete", async (c) => {
  const raw = c.req.param("id") ?? "";
  const id = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id)) return c.html(page("Bad request", "<p>Invalid id.</p>"), 400);
  if (id === c.get("user").id) {
    return c.html(page("Not allowed", "<p>You cannot delete your own account here.</p>"), 400);
  }
  await deleteUser(id);
  return c.redirect("/admin");
});
