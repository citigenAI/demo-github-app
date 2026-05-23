import { createTransport } from 'nodemailer';
import { Resend } from 'resend';
import { config } from '@/config';
import { logger } from '@/lib/logger';

type VerificationRequestParams = {
  identifier: string;
  url: string;
  expires: Date;
  provider: unknown;
  token: string;
  theme: unknown;
  request: Request;
};

export function buildEmailHtml(url: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Georgia,serif;background:#FFFFF8;color:#1C1917;margin:0;padding:40px 20px">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center">
      <table width="100%" style="max-width:560px" cellpadding="0" cellspacing="0">
        <tr><td style="padding-bottom:32px">
          <span style="font-family:Georgia,serif;font-size:24px;font-weight:600;color:#C2410C">Swara</span>
          <span style="font-family:Georgia,serif;font-size:18px;font-weight:300;color:#1C1917"> Magical Memories</span>
        </td></tr>
        <tr><td style="padding-bottom:24px">
          <p style="margin:0;font-size:16px;line-height:1.6">Hi,</p>
          <p style="margin:16px 0;font-size:16px;line-height:1.6">Use the button below to sign in to Swara Magical Memories. The link is valid for 24 hours and can be used once.</p>
        </td></tr>
        <tr><td style="padding-bottom:32px;text-align:center">
          <a href="${url}" style="display:inline-block;background:#C2410C;color:#FFFFF8;text-decoration:none;font-size:16px;font-weight:600;padding:14px 32px;border-radius:6px">Sign in</a>
        </td></tr>
        <tr><td style="padding-bottom:24px">
          <p style="margin:0;font-size:14px;color:#57534E">If the button doesn't work, copy and paste this link into your browser:</p>
          <p style="margin:8px 0;font-size:12px;color:#78716C;word-break:break-all">${url}</p>
        </td></tr>
        <tr><td style="border-top:1px solid #E7E5E4;padding-top:24px">
          <p style="margin:0;font-size:14px;color:#78716C">If you didn't request this, you can safely ignore this email.</p>
          <p style="margin:16px 0 0;font-size:14px;color:#78716C">— Swara Magical Memories<br><span style="font-size:12px">by Swara Media</span></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function buildEmailText(url: string): string {
  return [
    'Sign in to Swara Magical Memories',
    '',
    'Hi,',
    '',
    'Use the link below to sign in. The link is valid for 24 hours and can be used once.',
    '',
    url,
    '',
    "If you didn't request this, you can safely ignore this email.",
    '',
    '— Swara Magical Memories',
    'by Swara Media',
  ].join('\n');
}

export async function sendVerificationRequest({
  identifier,
  url,
}: VerificationRequestParams): Promise<void> {
  const subject = 'Your sign-in link for Swara Magical Memories';
  const html = buildEmailHtml(url);
  const text = buildEmailText(url);

  const useProd = config.env === 'production' && !!config.email.resendApiKey;

  if (useProd) {
    const resend = new Resend(config.email.resendApiKey);
    const { error } = await resend.emails.send({
      from: config.email.fromAddress,
      to: identifier,
      subject,
      html,
      text,
    });
    if (error) {
      logger.warn({ event: 'auth.magic_link.failed', error: error.message }, 'Magic link send failed (Resend)');
      throw new Error(`Resend send failed: ${error.message}`);
    }
  } else {
    const transport = createTransport({
      host: config.email.smtpHost,
      port: config.email.smtpPort,
      secure: false,
      auth: undefined,
    });
    await transport.sendMail({
      from: config.email.fromAddress,
      to: identifier,
      subject,
      html,
      text,
    });
  }

  logger.info({ event: 'auth.magic_link.sent' }, 'Magic link sent');
}
