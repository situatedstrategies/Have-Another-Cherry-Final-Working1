import { Resend } from 'resend';
import fs from 'fs/promises';
import path from 'path';

// Compliance footer appended to every user-facing email: why you got this,
// what we keep (your email address, nothing more), how to unsubscribe, and a
// deliverability nudge. Injected right before </body> on template emails and
// appended to code-built ones.
const EMAIL_COMPLIANCE_FOOTER = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;">
  <tr><td align="center" style="padding:18px 24px 30px 24px;font-family:'Inter',Helvetica,Arial,sans-serif;">
    <p style="margin:0 0 6px 0;font-size:11px;color:#71717A;line-height:1.6;">
      You're receiving this because you use Have Another Cherry, or someone invited you.
      We save your email address to service your account and nothing more: we never sell it or share it.
    </p>
    <p style="margin:0 0 6px 0;font-size:11px;color:#71717A;line-height:1.6;">
      Don't want emails from us?
      <a href="mailto:help@haveanothercherry.com?subject=Unsubscribe" style="color:#C41200;">Unsubscribe</a>
      and we'll stop, aside from essential account emails like password resets you request.
    </p>
    <p style="margin:0;font-size:11px;color:#71717A;line-height:1.6;">
      To make sure our emails reach you, add our @haveanothercherry.com senders to your contacts or safe senders list.
    </p>
  </td></tr>
</table>`;

const withComplianceFooter = (html: string): string =>
  html.includes('</body>')
    ? html.replace('</body>', `${EMAIL_COMPLIANCE_FOOTER}</body>`)
    : html + EMAIL_COMPLIANCE_FOOTER;

function escapeHtml(input: string): string {
  return String(input == null ? '' : input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface SplitEntry {
  name: string;
  split: number;
}

// Headers Gmail, Yahoo and Outlook read when deciding inbox versus spam. A
// List-Unsubscribe header is the one they weigh most for a sender they have
// not seen much of yet: without it a young domain's mail reads as a stranger
// with no way out, with it the client offers an unsubscribe control and
// treats the sender as accountable. The footer copy already promises the
// same address; this puts it where the filters look. Reply-To reaches a
// person, which is also a reputation signal.
const DELIVERABILITY_HEADERS = {
  'List-Unsubscribe': '<mailto:help@haveanothercherry.com?subject=Unsubscribe>',
};
const REPLY_TO_HELP = 'help@haveanothercherry.com';

export async function sendInviteEmail(
  email: string,
  groupName: string,
  inviteCode: string,
  recipientName?: string,
  fromName?: string,
  split?: SplitEntry[]
) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const resend = new Resend(apiKey);

  const templatePath = path.join(process.cwd(), 'server/templates/inviteEmail.html');
  let htmlTemplate = '';
  try {
    htmlTemplate = await fs.readFile(templatePath, 'utf-8');
  } catch (error) {
    console.error('Failed to load email template:', error);
    throw new Error('Could not load email template.');
  }

  const safeRecipient = recipientName && recipientName.trim() ? recipientName.trim() : 'there';
  const safeFrom = fromName && fromName.trim() ? fromName.trim() : 'A friend';

  const rowStyleName =
    "padding:11px 0;border-bottom:1px solid #E4E4E7;font-family:'Inter',Helvetica,Arial,sans-serif;font-size:15px;color:#18181B;font-weight:500;";
  const rowStylePct =
    "padding:11px 0;border-bottom:1px solid #E4E4E7;text-align:right;font-family:'JetBrains Mono',ui-monospace,monospace;font-size:15px;color:#C41200;font-weight:700;";

  const entries = Array.isArray(split) ? split.filter((s) => s && s.name) : [];
  let splitRows: string;
  if (entries.length) {
    splitRows = entries
      .map((s) => {
        const pct = Math.round((Number(s.split) || 0) * 10) / 10;
        return (
          '<tr><td style="' +
          rowStyleName +
          '">' +
          escapeHtml(s.name) +
          '</td><td style="' +
          rowStylePct +
          '">' +
          pct +
          '%</td></tr>'
        );
      })
      .join('');
  } else {
    splitRows =
      '<tr><td style="padding:11px 0;font-family:Inter,Helvetica,Arial,sans-serif;font-size:14px;color:#52525B;">The split gets set up in the app.</td></tr>';
  }

  const htmlContent = htmlTemplate
    .split('{{recipientName}}')
    .join(escapeHtml(safeRecipient))
    .split('{{fromName}}')
    .join(escapeHtml(safeFrom))
    .split('{{groupName}}')
    .join(escapeHtml(groupName || 'your group'))
    .split('{{inviteCode}}')
    .join(escapeHtml(inviteCode || ''))
    .split('{{splitRows}}')
    .join(splitRows);

  const { data, error } = await resend.emails.send({
    headers: DELIVERABILITY_HEADERS,
    replyTo: REPLY_TO_HELP,
    from: 'Have Another Cherry <poolside@haveanothercherry.com>',
    to: [email],
    subject: safeFrom + ' invited you to ' + groupName + ' on Have Another Cherry',
    html: withComplianceFooter(htmlContent),
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// Send an email-verification link via Resend from verify@haveanothercherry.com.
// The verifyLink is generated server-side by the Firebase Admin SDK, so Firebase
// never sends its own copy - this is the only verification email a user gets.
export async function sendVerificationEmail(
  email: string,
  verifyLink: string,
  recipientName?: string
) {
  // Verification uses its own Resend key when one is configured, falling back to
  // the shared key so the flow works before a dedicated key exists.
  const apiKey = process.env.VERIFY_RESEND_API || process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('No Resend API key configured for verification emails');
  }

  const resend = new Resend(apiKey);

  const templatePath = path.join(process.cwd(), 'server/templates/verifyEmail.html');
  let htmlTemplate = '';
  try {
    htmlTemplate = await fs.readFile(templatePath, 'utf-8');
  } catch (error) {
    console.error('Failed to load verification email template:', error);
    throw new Error('Could not load verification email template.');
  }

  const safeRecipient = recipientName && recipientName.trim() ? recipientName.trim() : 'there';

  const htmlContent = htmlTemplate
    .split('{{recipientName}}')
    .join(escapeHtml(safeRecipient))
    .split('{{verifyLink}}')
    .join(escapeHtml(verifyLink));

  const { data, error } = await resend.emails.send({
    headers: DELIVERABILITY_HEADERS,
    replyTo: REPLY_TO_HELP,
    from: 'Have Another Cherry <verify@haveanothercherry.com>',
    to: [email],
    subject: 'Confirm your email for Have Another Cherry',
    html: withComplianceFooter(htmlContent),
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// Send a password reset email via Resend from reset@haveanothercherry.com.
// The resetLink is generated server-side by the Firebase Admin SDK.
export async function sendResetEmail(email: string, resetLink: string, recipientName?: string) {
  // Reset emails use their own Resend key (RESET_RESEND_API); fall back to the
  // shared RESEND_API_KEY if the dedicated one isn't configured.
  const apiKey = process.env.RESET_RESEND_API || process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESET_RESEND_API is not configured');
  }

  const resend = new Resend(apiKey);

  const templatePath = path.join(process.cwd(), 'server/templates/resetEmail.html');
  let htmlTemplate = '';
  try {
    htmlTemplate = await fs.readFile(templatePath, 'utf-8');
  } catch (error) {
    console.error('Failed to load reset email template:', error);
    throw new Error('Could not load reset email template.');
  }

  const safeRecipient = recipientName && recipientName.trim() ? recipientName.trim() : 'there';

  const htmlContent = htmlTemplate
    .split('{{recipientName}}')
    .join(escapeHtml(safeRecipient))
    .split('{{resetLink}}')
    .join(escapeHtml(resetLink));

  const { data, error } = await resend.emails.send({
    headers: DELIVERABILITY_HEADERS,
    replyTo: REPLY_TO_HELP,
    from: 'Have Another Cherry <reset@haveanothercherry.com>',
    to: [email],
    subject: 'Reset your Have Another Cherry password',
    html: withComplianceFooter(htmlContent),
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// Cherry + waitlist: forward each signup to the poolside@ inbox so the list
// lives wherever that mailbox forwards (and can be imported into Mailchimp or
// similar later). If MAILCHIMP_API_KEY / MAILCHIMP_SERVER_PREFIX /
// MAILCHIMP_AUDIENCE_ID are ever configured, the server endpoint subscribes
// the address there too - this email is the always-works baseline.
export async function sendWaitlistNotification(subscriberEmail: string) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const resend = new Resend(apiKey);

  const { data, error } = await resend.emails.send({
    headers: DELIVERABILITY_HEADERS,
    replyTo: REPLY_TO_HELP,
    from: 'Have Another Cherry <notifications@haveanothercherry.com>',
    to: 'poolside@haveanothercherry.com',
    subject: 'Cherry + waitlist signup',
    text:
      `New Cherry + waitlist signup:\n\n${subscriberEmail}\n\n` +
      `Signed up ${new Date().toISOString()} from the in-app coming-soon page.`,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// Beta signup: forward each "get on the list" submission from the marketing
// site's beta form to the poolside@ inbox. This carries marketing data only
// (name, email, stated preferences) - never any ledger detail.
export async function sendBetaSignupNotification(signup: {
  name: string;
  email: string;
  household: string;
  interests: string;
  notes: string;
  source: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const resend = new Resend(apiKey);

  const { data, error } = await resend.emails.send({
    headers: DELIVERABILITY_HEADERS,
    from: 'Have Another Cherry <notifications@haveanothercherry.com>',
    to: 'poolside@haveanothercherry.com',
    replyTo: signup.email,
    subject: `Beta signup: ${signup.name || signup.email}`,
    text:
      `New beta signup from the marketing site:\n\n` +
      `Name: ${signup.name || 'not given'}\n` +
      `Email: ${signup.email}\n` +
      `Shares money with: ${signup.household || 'not given'}\n` +
      `Wants to test: ${signup.interests || 'not given'}\n` +
      `Notes: ${signup.notes || 'none'}\n` +
      `Page: ${signup.source || 'unknown'}\n\n` +
      `Signed up ${new Date().toISOString()} with consent to be emailed.`,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// Cherry + payment reminder, sent on a member's behalf from
// tartcherry@haveanothercherry.com. Deliberately warm and no-pressure: the
// point of the feature is that nobody has to send the awkward text.
// PRIVACY: this email deliberately contains NO amounts, item names, or any
// financial detail. Everything sent through Resend is visible in the Resend
// dashboard to the account operator, so anything put in an email is readable
// by anyone with that dashboard, whatever the ledger's own encryption does.
// The email only says an open balance exists; the details live in the app.
export async function sendReminderEmail(
  toEmail: string,
  toName: string,
  fromName: string,
  groupName: string
) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const resend = new Resend(apiKey);

  const html = `
  <div style="font-family: Inter, Helvetica, Arial, sans-serif; background:#F4F4F5; padding:32px 16px;">
    <div style="max-width:520px; margin:0 auto; background:#FFFFFF; border:1px solid #D4D4D8; border-radius:16px; padding:32px;">
      <h1 style="font-family: Georgia, serif; font-size:22px; color:#18181B; margin:0 0 16px;">A gentle nudge from ${groupName}</h1>
      <p style="color:#52525B; font-size:14.5px; line-height:1.6; margin:0 0 16px;">
        Hi ${toName || 'there'}, ${fromName} sent a friendly reminder from Have Another Cherry.
        There's an open balance waiting for you in ${groupName}. No rush and no pressure:
        this is just the app doing the asking so nobody has to.
      </p>
      <p style="color:#52525B; font-size:13px; line-height:1.6; margin:0 0 20px;">
        For your privacy, this email never includes amounts or expense details.
        Open the app to see exactly what's open and settle in a tap.
      </p>
      <a href="https://app.haveanothercherry.com" style="display:inline-block; background:#C41200; color:#ffffff; font-size:14px; font-weight:bold; padding:12px 24px; border-radius:999px; text-decoration:none;">Open Have Another Cherry</a>
      <p style="color:#71717A; font-size:11.5px; line-height:1.6; margin:20px 0 0;">
        Pay what you can, when you can. If you've already settled up, you can ignore this note: balances update as soon as payments are confirmed.
      </p>
    </div>
    <p style="text-align:center; color:#71717A; font-size:11px; margin:16px 0 0;">Have Another Cherry. Split fairly. Settle easily.</p>
  </div>`;

  const { data, error } = await resend.emails.send({
    headers: DELIVERABILITY_HEADERS,
    replyTo: REPLY_TO_HELP,
    from: 'Have Another Cherry <tartcherry@haveanothercherry.com>',
    to: toEmail,
    subject: `A gentle reminder from ${fromName} (${groupName})`,
    html: withComplianceFooter(html),
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

// Support request from inside the app. Goes to help@haveanothercherry.com with
// replyTo set to the sender, so answering is a plain reply rather than a
// copy-paste of an address out of the body.
//
// The message is whatever the user typed plus the context the app already
// knows (platform, version, screen). It must never carry ledger content: the
// point of a support form is that someone can describe a problem without
// handing over what they spent money on.
export async function sendSupportRequest(request: {
  fromEmail: string;
  fromName?: string;
  message: string;
  context?: string;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const resend = new Resend(apiKey);
  const who = request.fromName?.trim()
    ? `${request.fromName.trim()} <${request.fromEmail}>`
    : request.fromEmail;

  const { data, error } = await resend.emails.send({
    headers: DELIVERABILITY_HEADERS,
    from: 'Have Another Cherry <notifications@haveanothercherry.com>',
    to: 'help@haveanothercherry.com',
    replyTo: request.fromEmail,
    subject: `[Support] ${request.fromEmail}`,
    text:
      `Support request from ${who}\n\n` +
      `${request.message.trim()}\n\n` +
      `--- app context ---\n` +
      `${request.context?.trim() || '(none supplied)'}\n` +
      `Received ${new Date().toISOString()}`,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data;
}
