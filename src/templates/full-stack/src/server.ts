import { app } from "./app";
import { sqlite } from "./db";
import { bootDatabase } from "./db/lifecycle";
import { loadEnv } from "./env";

const env = loadEnv();

// Boot ordering: backup (when migrations are pending on an existing
// database), migrate, then serve. Failure exits before the health check
// can pass, so the previous deployment stays live.
await bootDatabase(sqlite, env.DB_PATH);

const server = Bun.serve({
  port: env.PORT,
  // Cap request bodies so an unauthenticated client cannot exhaust memory
  // before a route (or its rate limiter) runs. Raise it for large uploads.
  maxRequestBodySize: 1024 * 1024,
  fetch: app.fetch,
});

console.log(`Listening on http://localhost:${server.port}`);

// Graceful shutdown: stop accepting connections, let in-flight requests
// finish, then exit. The container runtime sends SIGTERM on replacement.
async function shutdown(code: number): Promise<void> {
  await server.stop();
  process.exit(code);
}
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
