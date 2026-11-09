import crypto from 'node:crypto';
import { one, all, parseQuestion } from './db.js';
import { config } from './config.js';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

/**
 * International format (+ and digits), or null if invalid. Numbers typed without a
 * country code are treated as local to DEFAULT_COUNTRY_CODE (Lebanon, +961):
 * "03 123 456" → +9613123456, "70 123 456" → +96170123456.
 */
export function normalizePhone(input, cc = config.defaultCountryCode) {
  if (!input) return null;
  let s = String(input).trim().replace(/[\s\-().\/]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    if (!/^\d+$/.test(s)) return null;
    if (s.startsWith('0')) s = cc + s.slice(1); // local trunk prefix
    else if (!(s.startsWith(cc) && s.length > cc.length + 6)) s = cc + s; // local number without 0
    s = '+' + s;
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

export const PHONE_EXAMPLE = '+961 70 123 456';

export function videoEmbed(lesson) {
  if (lesson.stream_uid) {
    if (lesson.stream_state === 'ready' && lesson.stream_hls) return { type: 'stream', src: lesson.stream_hls, poster: lesson.stream_thumbnail };
    return { type: 'processing', state: lesson.stream_state };
  }
  if (lesson.video_file) return { type: 'file', src: `/uploads/${lesson.video_file}` };
  const url = lesson.video_url;
  if (!url) return null;
  let m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (m) return { type: 'youtube', src: `https://www.youtube-nocookie.com/embed/${m[1]}?rel=0` };
  m = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (m) return { type: 'vimeo', src: `https://player.vimeo.com/video/${m[1]}` };
  if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(url)) return { type: 'file', src: url };
  return { type: 'link', src: url };
}

/** Per-lesson progress for one enrollment, used by student and teacher views. */
export function courseProgress(enrollmentId, courseId) {
  const lessons = all('SELECT * FROM lessons WHERE course_id=? ORDER BY position, id', courseId);
  const progress = new Map(all('SELECT * FROM lesson_progress WHERE enrollment_id=?', enrollmentId).map((p) => [p.lesson_id, p]));
  const answers = new Map(all('SELECT * FROM answers WHERE enrollment_id=?', enrollmentId).map((a) => [a.question_id, a]));
  let watched = 0, total = 0, correct = 0, answered = 0, done = 0;
  const rows = lessons.map((l) => {
    const qs = all('SELECT * FROM questions WHERE lesson_id=? ORDER BY position, id', l.id).map(parseQuestion);
    const p = progress.get(l.id) || {};
    const lesAnswers = qs.map((q) => answers.get(q.id)).filter(Boolean);
    const lesCorrect = lesAnswers.filter((a) => a.is_correct).length;
    const complete = Boolean(p.watched_at) && lesAnswers.length === qs.length;
    if (p.watched_at) watched++;
    if (complete) done++;
    total += qs.length;
    answered += lesAnswers.length;
    correct += lesCorrect;
    return { lesson: l, questions: qs, progress: p, answered: lesAnswers.length, correct: lesCorrect, complete, answers };
  });
  return {
    lessons: rows,
    watched,
    done,
    totalQuestions: total,
    answered,
    correct,
    pct: lessons.length ? Math.round((done / lessons.length) * 100) : 0,
    scorePct: answered ? Math.round((correct / answered) * 100) : null,
  };
}

export function courseWithTeacher(id) {
  return one(
    `SELECT c.*, u.name AS teacher_name,
            (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) AS lesson_count,
            (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) AS student_count
       FROM courses c JOIN users u ON u.id=c.teacher_id WHERE c.id=?`,
    id
  );
}

export const WA_STATE_LABEL = {
  pending: 'Starting…',
  awaiting_join: 'Waiting for student to join',
  awaiting_watch: 'Watching lesson',
  quizzing: 'Answering questions',
  done: 'Completed',
  error: 'Needs attention',
  stopped: 'Paused',
};

export const WA_STATE_TONE = {
  pending: 'teal',
  awaiting_join: 'amber',
  awaiting_watch: 'teal',
  quizzing: 'teal',
  done: 'green',
  error: 'red',
  stopped: '',
};

export function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}
