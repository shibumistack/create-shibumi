// Local preview of public/. Production serving is the pinned static image
// that bun ship builds; this file never ships.
import { realpathSync } from "node:fs";
import { join, normalize } from "node:path";

const ROOT = join(import.meta.dir, "..", "public");
function withHeaders(res: Response): Response {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return res;
}
const server = Bun.serve({
  port: Number(process.env.PORT) || 4173,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return withHeaders(new Response("Not found", { status: 404 }));
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return withHeaders(new Response("Bad request", { status: 400 }));
    }
    const safe = normalize(pathname).replaceAll("\\", "/");
    if (safe.includes("..")) return withHeaders(new Response("Not found", { status: 404 }));
    const candidate = safe.endsWith("/") ? join(ROOT, safe, "index.html") : join(ROOT, safe);
    if (!candidate.startsWith(ROOT)) return withHeaders(new Response("Not found", { status: 404 }));
    let resolved;
    try {
      resolved = realpathSync(candidate);
    } catch {
      resolved = undefined;
    }
    // realpath containment: a symlink inside public/ must not escape it.
    if (resolved && (resolved === realpathSync(ROOT) || resolved.startsWith(realpathSync(ROOT) + "/"))) {
      const file = Bun.file(resolved);
      if (await file.exists()) return withHeaders(new Response(file));
    }
    const notFound = Bun.file(join(ROOT, "404.html"));
    return withHeaders(new Response((await notFound.exists()) ? notFound : "Not found", { status: 404 }));
  },
});
console.log(`Previewing public/ on http://localhost:${server.port}`);
