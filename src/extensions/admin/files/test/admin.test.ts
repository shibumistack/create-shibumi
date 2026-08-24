import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "admin-test-")), "app.db");
process.env.ADMIN_EMAILS = "boss@example.com, Owner@Example.com";
const { app } = await import("../src/app");
const { sqlite } = await import("../src/db");
const { applyMigrations } = await import("../src/db/lifecycle");
const { createUser, createSession, SESSION_COOKIE } = await import("../src/lib/auth");
const { isAdmin, listUsers } = await import("../src/lib/admin");
await applyMigrations(sqlite);

let counter = 0;
async function makeUser(email?: string): Promise<{ id: number; email: string; cookie: string }> {
  counter += 1;
  const addr = email ?? `member${counter}-${Date.now()}@example.com`;
  const user = await createUser(addr, "password123");
  const token = await createSession(user.id);
  return { id: user.id, email: addr, cookie: `${SESSION_COOKIE}=${token}` };
}

let admin: { id: number; cookie: string };
beforeAll(async () => {
  admin = await makeUser("boss@example.com");
});

describe("isAdmin", () => {
  it("matches the allowlist case-insensitively and rejects others", () => {
    expect(isAdmin("boss@example.com")).toBe(true);
    expect(isAdmin("owner@example.com")).toBe(true);
    expect(isAdmin("OWNER@EXAMPLE.COM")).toBe(true);
    expect(isAdmin("nobody@example.com")).toBe(false);
    expect(isAdmin("")).toBe(false);
  });
});

describe("access control", () => {
  it("401s when signed out", async () => {
    const res = await app.fetch(new Request("http://localhost/admin"));
    expect(res.status).toBe(401);
  });

  it("403s a signed-in non-admin", async () => {
    const member = await makeUser();
    const res = await app.fetch(new Request("http://localhost/admin", { headers: { cookie: member.cookie } }));
    expect(res.status).toBe(403);
  });

  it("renders the user table for an admin", async () => {
    const member = await makeUser("visible@example.com");
    const res = await app.fetch(new Request("http://localhost/admin", { headers: { cookie: admin.cookie } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("visible@example.com");
    expect(html).toContain("/admin/users/");
    void member;
  });
});

describe("delete user", () => {
  it("blocks cross-origin form posts (CSRF)", async () => {
    const target = await makeUser();
    const res = await app.fetch(
      new Request(`http://localhost/admin/users/${target.id}/delete`, {
        method: "POST",
        headers: { cookie: admin.cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      })
    );
    expect(res.status).toBe(403);
  });

  it("lets an admin delete another user and refuses self-delete", async () => {
    const target = await makeUser("doomed@example.com");
    const before = listUsers().length;

    const selfDelete = await app.fetch(
      new Request(`http://localhost/admin/users/${admin.id}/delete`, {
        method: "POST",
        headers: { cookie: admin.cookie, origin: "http://localhost" },
      })
    );
    expect(selfDelete.status).toBe(400);

    const res = await app.fetch(
      new Request(`http://localhost/admin/users/${target.id}/delete`, {
        method: "POST",
        headers: { cookie: admin.cookie, origin: "http://localhost" },
      })
    );
    expect(res.status).toBe(302);
    expect(listUsers().length).toBe(before - 1);
    expect(listUsers().some((row) => row.email === "doomed@example.com")).toBe(false);
  });

  it("a non-admin cannot delete", async () => {
    const attacker = await makeUser();
    const target = await makeUser();
    const res = await app.fetch(
      new Request(`http://localhost/admin/users/${target.id}/delete`, {
        method: "POST",
        headers: { cookie: attacker.cookie, origin: "http://localhost" },
      })
    );
    expect(res.status).toBe(403);
    expect(listUsers().some((row) => row.id === target.id)).toBe(true);
  });
});
