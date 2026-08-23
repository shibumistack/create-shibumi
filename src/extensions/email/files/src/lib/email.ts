import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

/**
 * Send a transactional email via Resend.
 * Set RESEND_API_KEY in your .env file.
 */
export async function sendEmail(options: EmailOptions): Promise<void> {
  const { to, subject, html, from = "noreply@yourdomain.com" } = options;

  const { error } = await resend.emails.send({
    from,
    to: [to],
    subject,
    html,
  });

  if (error) {
    console.error("Email send failed:", error);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

/**
 * Send a welcome email after signup.
 */
export async function sendWelcomeEmail(
  to: string,
  name: string
): Promise<void> {
  await sendEmail({
    to,
    subject: "Welcome",
    html: `
      <h1>Welcome, ${name}</h1>
      <p>Your account is ready.</p>
    `,
  });
}
