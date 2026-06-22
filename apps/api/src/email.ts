import { config } from "./config.js";

// Transactional email. The provider interface lets the backend send real email
// in production (Resend) while falling back to logging the link locally, so the
// verify and reset flows are fully testable without an email account.

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

// Logs the email (including the link) to the server output instead of sending.
// Used in local development and any time no email provider is configured, so the
// verify and reset links are visible in the terminal running the backend.
class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";
  async send(message: EmailMessage): Promise<void> {
    // The text body carries the link in plain form; print it clearly so a
    // developer or tester can click it from the terminal.
    console.info(
      `\n[WorkCrew email] (not sent, no email provider configured)\n  To: ${message.to}\n  Subject: ${message.subject}\n  ${message.text}\n`
    );
  }
}

// Sends real email through Resend's HTTP API. Needs only an API key and a from
// address; no SDK dependency.
class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  constructor(private readonly apiKey: string, private readonly from: string) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Email send failed (${response.status}): ${detail.slice(0, 300)}`);
    }
  }
}

let provider: EmailProvider | null = null;

/** The active email provider, chosen once from configuration. */
export function emailProvider(): EmailProvider {
  if (provider) return provider;
  provider = config.resendApiKey
    ? new ResendEmailProvider(config.resendApiKey, config.emailFrom)
    : new ConsoleEmailProvider();
  return provider;
}

/** Whether real email sending is configured (vs. the console fallback). */
export function emailSendingEnabled(): boolean {
  return Boolean(config.resendApiKey);
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  await emailProvider().send(message);
}

// ---------------------------------------------------------------------------
// Templates. Plain, branded, and free of any provider or vendor name.
// ---------------------------------------------------------------------------

function shell(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#1f1e1d;font-family:Segoe UI,Arial,sans-serif;color:#e8e6e3;padding:32px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#262523;border:1px solid #3a3836;border-radius:16px;padding:28px">
        <tr><td style="font-size:18px;font-weight:700;color:#a78bfa;padding-bottom:6px">WorkCrew</td></tr>
        <tr><td style="font-size:20px;font-weight:700;padding-bottom:12px">${title}</td></tr>
        <tr><td style="font-size:14px;line-height:1.6;color:#c9c6c2">${bodyHtml}</td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

// A centered, block-level call-to-action button on its own line, so it never
// wraps awkwardly into the surrounding text.
function button(href: string, label: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td align="center">
    <a href="${href}" style="display:inline-block;padding:13px 28px;background:#8b5cf6;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px">${label}</a>
  </td></tr></table>`;
}

function fallbackLink(link: string): string {
  return `<p style="margin:0 0 6px;color:#9a948c;font-size:13px">If the button does not work, paste this link into your browser:</p><p style="margin:0;color:#a78bfa;word-break:break-all;font-size:13px">${link}</p>`;
}

export function verifyEmailMessage(to: string, link: string): EmailMessage {
  return {
    to,
    subject: "Verify your WorkCrew email",
    html: shell(
      "Confirm your email",
      `<p style="margin:0">Welcome to WorkCrew. Confirm this email address to activate your account.</p>${button(link, "Verify email")}${fallbackLink(link)}<p style="margin:18px 0 0;color:#9a948c;font-size:13px">If you did not create a WorkCrew account, you can ignore this message.</p>`
    ),
    text: `Welcome to WorkCrew. Verify your email by opening this link: ${link}`
  };
}

export function resetEmailMessage(to: string, link: string): EmailMessage {
  return {
    to,
    subject: "Reset your WorkCrew password",
    html: shell(
      "Reset your password",
      `<p style="margin:0">We received a request to reset your WorkCrew password. Choose a new one here.</p>${button(link, "Reset password")}${fallbackLink(link)}<p style="margin:18px 0 0;color:#9a948c;font-size:13px">This link expires in one hour. If you did not request this, you can ignore this message and your password stays the same.</p>`
    ),
    text: `Reset your WorkCrew password by opening this link (expires in one hour): ${link}`
  };
}
