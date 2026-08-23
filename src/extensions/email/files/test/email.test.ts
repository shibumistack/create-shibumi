import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";

// loadEnv reads process.env on each call; set the email vars before import
// so sends are configured for the whole file.
process.env.RESEND_API_KEY = "re_test_key";
process.env.EMAIL_FROM = "App <app@example.com>";
const { escapeHtml, renderTemplate, sendEmail, verifyResendWebhook } = await import(
  "../src/lib/email"
);

interface RecordedRequest {
  url: string;
  init: RequestInit;
}

function fetcherReturning(status: number, body: unknown, recorded: RecordedRequest[] = []) {
  return async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    recorded.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  };
}

describe("sendEmail", () => {
  it("posts the payload to Resend with the bearer key and returns the id", async () => {
    const recorded: RecordedRequest[] = [];
    const result = await sendEmail(
      { to: "user@example.com", subject: "Hello", html: "<p>Hi</p>" },
      fetcherReturning(200, { id: "email_123" }, recorded)
    );
    expect(result.id).toBe("email_123");
    expect(recorded.length).toBe(1);
    expect(recorded[0]!.url).toBe("https://api.resend.com/emails");
    const headers = recorded[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test_key");
    const payload = JSON.parse(String(recorded[0]!.init.body));
    expect(payload).toEqual({
      from: "App <app@example.com>",
      to: ["user@example.com"],
      subject: "Hello",
      html: "<p>Hi</p>",
    });
  });

  it("prefers an explicit from address", async () => {
    const recorded: RecordedRequest[] = [];
    await sendEmail(
      { to: "user@example.com", subject: "Hi", text: "hi", from: "Other <other@example.com>" },
      fetcherReturning(200, { id: "email_1" }, recorded)
    );
    expect(JSON.parse(String(recorded[0]!.init.body)).from).toBe("Other <other@example.com>");
  });

  it("requires content and surfaces Resend rejections", async () => {
    await expect(
      sendEmail({ to: "user@example.com", subject: "Empty" }, fetcherReturning(200, { id: "x" }))
    ).rejects.toThrow("html or text");
    await expect(
      sendEmail(
        { to: "user@example.com", subject: "Nope", text: "hi" },
        fetcherReturning(422, { message: "invalid" })
      )
    ).rejects.toThrow("422");
  });
});

describe("renderTemplate", () => {
  it("fills variables and escapes HTML in values", () => {
    const html = renderTemplate("<p>Hello {{name}}, your code is {{code}}</p>", {
      name: '<b>"Ada" & Co</b>',
      code: 1234,
    });
    expect(html).toBe(
      "<p>Hello &lt;b&gt;&quot;Ada&quot; &amp; Co&lt;/b&gt;, your code is 1234</p>"
    );
  });

  it("throws on a missing variable", () => {
    expect(() => renderTemplate("Hi {{name}}", {})).toThrow('Missing template variable "name"');
  });

  it("throws on placeholder names that would silently pass through", () => {
    expect(() => renderTemplate("Hi {{first-name}}", { name: "x" })).toThrow("Invalid template placeholder");
  });

  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

describe("verifyResendWebhook", () => {
  const secretBytes = Buffer.from("webhook-secret-key-for-tests");
  const secret = `whsec_${secretBytes.toString("base64")}`;

  function sign(id: string, timestamp: string, body: string): string {
    return createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${body}`).digest("base64");
  }

  it("accepts a valid signature and rejects tampered bodies", () => {
    const body = '{"type":"email.delivered"}';
    const nowMs = 1_700_000_000_000;
    const timestamp = String(nowMs / 1000);
    const headers = {
      "svix-id": "msg_1",
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${sign("msg_1", timestamp, body)}`,
    };
    expect(verifyResendWebhook(body, headers, secret, nowMs)).toBe(true);
    expect(verifyResendWebhook('{"type":"forged"}', headers, secret, nowMs)).toBe(false);
  });

  it("rejects stale timestamps and missing headers", () => {
    const body = "{}";
    const nowMs = 1_700_000_000_000;
    const staleTs = String(nowMs / 1000 - 600);
    const headers = {
      "svix-id": "msg_1",
      "svix-timestamp": staleTs,
      "svix-signature": `v1,${sign("msg_1", staleTs, body)}`,
    };
    expect(verifyResendWebhook(body, headers, secret, nowMs)).toBe(false);
    expect(verifyResendWebhook(body, {}, secret, nowMs)).toBe(false);
  });

  it("accepts any valid entry in a multi-signature header", () => {
    const body = "{}";
    const nowMs = 1_700_000_000_000;
    const timestamp = String(nowMs / 1000);
    const headers = {
      "svix-id": "msg_1",
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${Buffer.from("wrong").toString("base64")} v1,${sign("msg_1", timestamp, body)}`,
    };
    expect(verifyResendWebhook(body, headers, secret, nowMs)).toBe(true);
  });
});
