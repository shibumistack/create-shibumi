// Transactional email via Resend's HTTP API. Installed by
// `bun run shibumi add email`; this project owns the file. One fetch, no SDK
// dependency. Env (validated in src/env.ts): RESEND_API_KEY and EMAIL_FROM
// are required at send time, RESEND_WEBHOOK_SECRET only for webhooks.
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadEnv } from "../env";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface SendEmailInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  /** Defaults to EMAIL_FROM. */
  from?: string;
}

export interface SendEmailResult {
  id: string;
}

export type Fetcher = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

// `fetcher` exists for tests; production callers use the default.
export async function sendEmail(
  input: SendEmailInput,
  fetcher: Fetcher = fetch
): Promise<SendEmailResult> {
  const env = loadEnv();
  if (!env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not set. Add it to the environment before sending email.");
  }
  const from = input.from ?? env.EMAIL_FROM;
  if (!from) {
    throw new Error("No sender address. Set EMAIL_FROM or pass `from` explicitly.");
  }
  if (!input.html && !input.text) {
    throw new Error("Provide html or text content for the email.");
  }
  const response = await fetcher(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Resend rejected the send: ${response.status} ${detail}`);
  }
  const data = (await response.json()) as { id?: string };
  if (!data.id) {
    throw new Error("Resend responded without a message id.");
  }
  return { id: data.id };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Fills {{name}} placeholders, HTML-escaping every value. Throws on a
// placeholder without a value so typos fail in tests, not in inboxes.
export function renderTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_whole, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`Missing template variable "${name}".`);
    }
    return escapeHtml(String(value));
  });
}

// Verifies a Resend webhook (svix format): HMAC-SHA256 over
// "<id>.<timestamp>.<rawBody>" with the base64 part of the whsec_ secret,
// constant-time compare, 5-minute timestamp tolerance. Pass the raw request
// body string, not parsed JSON.
export function verifyResendWebhook(
  rawBody: string,
  headers: Record<string, string | undefined>,
  secret: string,
  nowMs = Date.now()
): boolean {
  const id = headers["svix-id"];
  const timestamp = headers["svix-timestamp"];
  const signatures = headers["svix-signature"];
  if (!id || !timestamp || !signatures) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(nowMs / 1000 - seconds) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest();
  for (const candidate of signatures.split(" ")) {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) continue;
    const provided = Buffer.from(value, "base64");
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
  }
  return false;
}
