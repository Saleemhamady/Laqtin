// Personal links sent in WhatsApp/Telegram messages. Tapping one opens the lesson
// straight away, without a password: the link itself proves who the student is.
//
//   /l/<enrollmentId>.<lessonId>.<expiry>.<signature>
//
// Signed with SESSION_SECRET (HMAC-SHA256), valid for 60 days. Only student
// accounts are signed in this way; a session opened by a link can't change the
// password, email links or delete the account (see requireFullLogin).
import crypto from 'node:crypto';
import { config } from './config.js';

const TTL_DAYS = 60;
const sign = (payload) => crypto.createHmac('sha256', config.sessionSecret).update(`link:${payload}`).digest('base64url').slice(0, 27);

/** lessonId 0 means "the course page". */
export function makeLink(enrollmentId, lessonId = 0, now = Date.now()) {
  const exp = Math.floor(now / 1000 / 86400) + TTL_DAYS; // expiry in days since epoch (short token)
  const payload = `${enrollmentId}.${lessonId}.${exp}`;
  return `${config.baseUrl}/l/${payload}.${sign(payload)}`;
}

export function readLink(token, now = Date.now()) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.([\w-]{27})$/.exec(String(token));
  if (!m) return null;
  const payload = `${m[1]}.${m[2]}.${m[3]}`;
  const expected = sign(payload);
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[4]))) return null;
  if (Number(m[3]) < Math.floor(now / 1000 / 86400)) return { expired: true, enrollmentId: Number(m[1]), lessonId: Number(m[2]) };
  return { enrollmentId: Number(m[1]), lessonId: Number(m[2]) };
}
