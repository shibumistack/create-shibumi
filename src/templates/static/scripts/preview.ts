// Local preview of public/. Production serving is the pinned static image
// that bun ship builds; this file never ships.
import { join, normalize } from "node:path";

const ROOT = join(import.meta.dir, "..", "public");
const server = Bun.serve({
  port: Number(process.env.PORT) || 4173,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Not found", { status: 404 });
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    const safe = normalize(pathname).replaceAll("\\", "/");
    if (safe.includes("..")) return new Response("Not found", { status: 404 });
    const candidate = safe.endsWith("/") ? join(ROOT, safe, "index.html") : join(ROOT, safe);
    if (!candidate.startsWith(ROOT)) return new Response("Not found", { status: 404 });
    const file = Bun.file(candidate);
    if (await file.exists()) return new Response(file);
    const notFound = Bun.file(join(ROOT, "404.html"));
    return new Response((await notFound.exists()) ? notFound : "Not found", { status: 404 });
  },
});
console.log(`Previewing public/ on http://localhost:${server.port}`);
