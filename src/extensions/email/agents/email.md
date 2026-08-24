# Email extension

Installed by `bun run shibumi add email`. This project owns every file below.

## Files

- `src/lib/email.ts`: `sendEmail`, `renderTemplate`, `escapeHtml`, `verifyResendWebhook`. Plain fetch to Resend's HTTP API; no SDK dependency.
- `test/email.test.ts`: send payload, template rendering and escaping, webhook signature coverage. Uses an injected fetcher; no network.

## Config

`src/config/email.yaml` (bundled at build) holds `webhook_tolerance_seconds` (default 300): how far a webhook timestamp may be from now before the signature is rejected. Validated at startup.

## Environment

Validated in `src/env.ts`, all optional at boot and checked at use:

- `RESEND_API_KEY`: required to send. Store it in the deployment environment, never in code or git.
- `EMAIL_FROM`: default sender, e.g. `App <app@yourdomain.com>`. The domain must be verified in Resend.
- `RESEND_WEBHOOK_SECRET`: only for webhook verification (`whsec_...`).

## Sending

```ts
import { renderTemplate, sendEmail } from "./lib/email";

await sendEmail({
  to: "user@example.com",
  subject: "Welcome",
  html: renderTemplate("<p>Hello {{name}}</p>", { name: user.name }),
});
```

`renderTemplate` HTML-escapes every variable and throws on a missing one; never interpolate user input into email HTML directly.

## Webhooks

Resend webhooks are svix-signed. Verify with the raw body string before parsing:

```ts
app.post("/webhooks/resend", async (c) => {
  const raw = await c.req.text();
  const env = loadEnv();
  if (!env.RESEND_WEBHOOK_SECRET || !verifyResendWebhook(raw, {
    "svix-id": c.req.header("svix-id"),
    "svix-timestamp": c.req.header("svix-timestamp"),
    "svix-signature": c.req.header("svix-signature"),
  }, env.RESEND_WEBHOOK_SECRET)) {
    return c.json({ error: "Invalid signature" }, 401);
  }
  const event = JSON.parse(raw);
  // handle event.type: email.delivered, email.bounced, ...
  return c.json({ ok: true });
});
```

Signature verification does not stop replays inside the 5-minute tolerance window: if a webhook triggers side effects, record processed `svix-id` values and skip duplicates.

## Removal

`bun run shibumi remove email` deletes the installed code and reverses the `src/env.ts` edit. No tables are involved.
