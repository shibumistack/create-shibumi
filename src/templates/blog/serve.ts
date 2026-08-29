import app from "./src/app";

const port = Number(process.env.SHIBUMI_PORT ?? process.env.PORT ?? 9001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("SHIBUMI_PORT must be an integer from 1 to 65535");
}

export default {
  port,
  fetch: app.fetch,
};