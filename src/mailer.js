import nodemailer from 'nodemailer';
import { config } from './config.js';

let transport = null;

export const mailEnabled = () => Boolean(config.smtp.url);

export async function sendMail({ to, subject, text, html }) {
  if (!mailEnabled()) {
    console.log(`[mail] SMTP not configured — would send to ${to}: ${subject}\n${text}`);
    return;
  }
  transport ||= nodemailer.createTransport(config.smtp.url);
  await transport.sendMail({ from: config.smtp.from, to, subject, text, html });
}
