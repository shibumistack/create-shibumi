import { app } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();

const server = Bun.serve({
  port: env.PORT,
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
