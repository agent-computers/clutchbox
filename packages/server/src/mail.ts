import 'server-only';
import { createTransport } from 'nodemailer';

// The email the server sends: sign-in links (auth.ts). Tests pass a fake in place of SMTP.
export type Email = { to: string; subject: string; text: string };
export type SendEmail = (email: Email) => Promise<void>;

// Sends through SMTP_URL from SMTP_FROM. The transport connects per message, so nothing stays open between requests.
export function smtpSender(url: string, from: string): SendEmail {
  const transport = createTransport(url);
  return async email => {
    await transport.sendMail({ from, ...email });
  };
}
