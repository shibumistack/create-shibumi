
## Email (added via shibumi add email)

- Email helper lives in `src/lib/email.ts`
- Uses Resend API: set `RESEND_API_KEY` in `.env`
- Send emails with `sendEmail({ to, subject, html })`
- For templates, keep HTML strings in `src/lib/email/` and import them
- Never log API keys or email content in production
