import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "hono/bun";
import { z } from "zod";

// The exact response header set; test/app.test.ts asserts every entry on
// success, error, API, and static responses. Change both together.
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

function applyHeaders(res: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(name, value);
  }
  return res;
}

// Factory so tests can build an instance and add probe routes before the
// router freezes on first dispatch.
export function createApp(): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    applyHeaders(c.res);
  });

  // Thrown errors bypass the middleware above (the exception unwinds past
  // its post-next line), so the error handler applies the same set.
  // Deliberate HTTP errors (framework middleware like CSRF throws
  // HTTPException) keep their status; everything else is a logged 500.
  app.onError((err, c) => {
    if (err instanceof HTTPException) return applyHeaders(err.getResponse());
    console.error(err);
    return applyHeaders(c.text("Internal error", 500));
  });

  app.get("/healthz", (c) => c.json({ ok: true }));

  const helloQuery = z.object({
    name: z.string().min(1).max(100).optional(),
  });

  app.get("/api/hello", (c) => {
    const parsed = helloQuery.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json({ error: "Invalid query" }, 400);
    }
    return c.json({ hello: parsed.data.name ?? "world" });
  });

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Web app · shibumi</title>
    <link rel="stylesheet" href="/public/vendor/shibumi.css" />
    <link rel="stylesheet" href="/public/style.css" />
    <!-- app.js must load before Alpine so the alpine:init listener exists
         when Alpine starts; both defer, so document order is execution order. -->
    <script src="/public/app.js" defer></script>
    <script src="/public/vendor/alpine-csp-3.16.2.min.js" defer></script>
  </head>
  <body>
    <main class="scaffold">
      <p class="masthead"><span class="masthead-mark">渋み</span> shibumi web</p>
      <h1>Web app</h1>
      <p class="lede">Hono serves the routes, Zod validates every input, and Alpine runs the client behavior. Deploy to your own server with one command.</p>
      <section class="demo" x-data="counter" aria-label="Alpine counter demo">
        <button x-on:click="inc" type="button">Count</button>
        <output x-text="count">0</output>
        <span class="demo-hint">client state without a build step</span>
      </section>
      <ul class="endpoints">
        <li><a href="/api/hello?name=you"><code>GET /api/hello</code><span>query validated with Zod</span></a></li>
        <li><a href="/healthz"><code>GET /healthz</code><span>the check every deploy waits for</span></a></li>
      </ul>
      <footer class="colophon">
        <p>This page lives in <code>src/app.ts</code>. House rules for coding agents are in <code>agents.md</code>. Add features with <code>bun shi add email</code>.</p>
        <p class="colophon-links"><a href="https://shibumistack.dev/docs" rel="noreferrer">shibumi docs</a> · <a href="https://server.shibumistack.dev/docs" rel="noreferrer">server docs</a> · <a href="https://shibumistack.dev/docs/cli/extensions" rel="noreferrer">extensions</a></p>
      </footer>
    </main>
  </body>
</html>
`;

  app.get("/", (c) => c.html(page));

  // GET-only: static files must not answer mutation verbs.
  app.get("/public/*", serveStatic({ root: "./" }));

  app.notFound((c) => c.text("Not found", 404));

  return app;
}

export const app = createApp();
