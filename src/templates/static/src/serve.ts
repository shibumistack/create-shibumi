import { readdirSync, readFileSync, existsSync } from "fs";
import { join, extname } from "path";

const DIST = join(import.meta.dir, "../dist");
const PORT = Number(Bun.env.PORT ?? 3000);

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".xml": "application/rss+xml",
};

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;

    if (path === "/") path = "/index.html";

    const file = join(DIST, path);

    if (existsSync(file)) {
      const ext = extname(file);
      return new Response(readFileSync(file), {
        headers: { "Content-Type": MIME[ext] || "application/octet-stream" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Serving dist/ on http://localhost:${server.port}`);
