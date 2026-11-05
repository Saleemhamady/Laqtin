// The learning journey that runs inside a chat app (WhatsApp or Telegram),
// independent of the provider. Each enrollment has a `channel`; the wa_* columns
// hold the journey state for whichever channel it uses.
//
//   enroll -> chat created (group) -> welcome -> lesson 1 video + "I watched it" poll
//          -> watched (WhatsApp poll OR portal player) -> question polls one by one
//          -> feedback after each vote -> lesson score -> next lesson ... -> certificate message
//
// Every step is persisted, and answers/watches coming from the web portal advance
// the same state, so the portal and WhatsApp always agree.
import { one, all, run, parseQuestion } from '../db.js';
import { config } from '../config.js';

const LETTERS = 'ABCDEFGHIJKL';
const queues = new Map();
const providers = {}; // channel -> provider
const listeners = new Set();

export function setProvider(p, channel = 'whatsapp') {
  providers[channel] = p;
}
export function getProvider(channel = 'whatsapp') {
  return providers[channel] || null;
}
export const channels = () => Object.keys(providers);
const prov = (e) => providers[e.channel || 'whatsapp'];
const maxVideoBytes = (p) => (p?.maxVideoMb ?? config.whatsapp.maxVideoMb) * 1024 * 1024;
export const CHANNEL_LABEL = { whatsapp: 'WhatsApp', telegram: 'Telegram' };
/** Subscribe to engine activity (used by tests and logs). */
export function onActivity(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Serialise all WhatsApp work per enrollment so steps never interleave. */
function enqueue(enrollmentId, fn, { evenIfStopped = false } = {}) {
  const prev = queues.get(enrollmentId) || Promise.resolve();
  const guarded = () => {
    const e = enrollment(enrollmentId);
    if (!e || (e.wa_state === 'stopped' && !evenIfStopped)) return;
    return fn();
  };
  const next = prev.then(guarded).catch((err) => {
    console.error(`[whatsapp] enrollment ${enrollmentId}:`, err);
    run(`UPDATE enrollments SET wa_state='error', wa_error=? WHERE id=?`, String(err?.message || err), enrollmentId);
  });
  queues.set(enrollmentId, next);
  next.finally(() => {
    if (queues.get(enrollmentId) === next) queues.delete(enrollmentId);
  });
  return next;
}

/** Resolves once every queued WhatsApp step has run (handy in tests). */
export async function idle() {
  while (queues.size) await Promise.all([...queues.values()]);
}

// ---------- data helpers ----------
const enrollment = (id) => one('SELECT * FROM enrollments WHERE id=?', id);
const lessonsOf = (courseId) => all('SELECT * FROM lessons WHERE course_id=? ORDER BY position, id', courseId);
const questionsOf = (lessonId) => all('SELECT * FROM questions WHERE lesson_id=? ORDER BY position, id', lessonId).map(parseQuestion);

function setState(id, fields) {
  const keys = Object.keys(fields);
  run(`UPDATE enrollments SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map((k) => fields[k]), id);
}

function log(enrollmentId, direction, kind, body, { ref = null, externalId = null } = {}) {
  run(
    `INSERT INTO wa_messages (enrollment_id, direction, kind, body, ref, external_id) VALUES (?,?,?,?,?,?)`,
    enrollmentId, direction, kind, JSON.stringify(body), ref, externalId
  );
  for (const fn of listeners) fn({ enrollmentId, direction, kind, body, ref });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pace(e) {
  const p = prov(e);
  const ms = config.whatsapp.sendDelayMs ?? p?.sendDelayMs ?? (p?.name === 'mock' ? 0 : 1500);
  if (ms > 0) await sleep(ms);
}

async function say(e, text) {
  await pace(e);
  const r = await prov(e).sendText(e.wa_chat_id, text);
  log(e.id, 'out', 'text', { text }, { externalId: r?.id });
}

async function poll(e, name, options, ref, quiz = null) {
  await pace(e);
  const r = await prov(e).sendPoll(e.wa_chat_id, { name: name.slice(0, 255), options, ...(quiz || {}) });
  log(e.id, 'out', 'poll', { name, options }, { ref, externalId: r.id });
}

const lessonLink = (lesson) => `${config.baseUrl}/learn/lesson/${lesson.id}`;

// ---------- recording (synchronous, shared by web + WhatsApp) ----------

/** Mark a lesson as watched. Returns true if this is the first time. */
const touched = (enrollmentId) => run(`UPDATE enrollments SET last_progress_at=datetime('now'), nudge_count=0 WHERE id=?`, enrollmentId);

export function recordWatch(enrollmentId, lessonId, via) {
  touched(enrollmentId);
  run(`INSERT OR IGNORE INTO lesson_progress (enrollment_id, lesson_id) VALUES (?,?)`, enrollmentId, lessonId);
  const r = run(
    `UPDATE lesson_progress SET watched_at=datetime('now'), watched_via=? WHERE enrollment_id=? AND lesson_id=? AND watched_at IS NULL`,
    via, enrollmentId, lessonId
  );
  return r.changes > 0;
}

/** Store an answer; the first answer to a question is the one that counts. */
export function recordAnswer(enrollmentId, questionId, selectedIndex, via) {
  const q = parseQuestion(one('SELECT * FROM questions WHERE id=?', questionId));
  if (!q) throw new Error('Unknown question');
  if (!(selectedIndex >= 0 && selectedIndex < q.options.length)) throw new Error('Invalid option');
  const existing = one('SELECT * FROM answers WHERE enrollment_id=? AND question_id=?', enrollmentId, questionId);
  if (existing) return { question: q, answer: existing, isNew: false };
  touched(enrollmentId);
  run(
    `INSERT INTO answers (enrollment_id, question_id, selected_index, is_correct, via) VALUES (?,?,?,?,?)`,
    enrollmentId, questionId, selectedIndex, selectedIndex === q.correct_index ? 1 : 0, via
  );
  const answer = one('SELECT * FROM answers WHERE enrollment_id=? AND question_id=?', enrollmentId, questionId);
  return { question: q, answer, isNew: true };
}

// ---------- journey steps (run inside the per-enrollment queue) ----------

async function deliverLesson(e, lesson) {
  if (!lesson) return complete(e);
  const lessons = lessonsOf(e.course_id);
  const idx = lessons.findIndex((l) => l.id === lesson.id);
  setState(e.id, { current_lesson_id: lesson.id, current_question_id: null, wa_state: 'awaiting_watch', wa_error: null });
  e = enrollment(e.id);

  const caption =
    `📺 *Lesson ${idx + 1}/${lessons.length}: ${lesson.title}*` +
    (lesson.description ? `\n\n${lesson.description}` : '') +
    `\n\n▶️ Watch it here: ${lessonLink(lesson)}`;

  const smallFile = lesson.video_file && lesson.video_size && lesson.video_size <= maxVideoBytes(prov(e));
  if (smallFile && prov(e).sendVideo) {
    await pace(e);
    const r = await prov(e).sendVideo(e.wa_chat_id, {
      filePath: `${config.uploadDir}/${lesson.video_file}`,
      url: `${config.baseUrl}/uploads/${lesson.video_file}`,
      caption,
    });
    log(e.id, 'out', 'video', { caption, video: `/uploads/${lesson.video_file}` }, { externalId: r?.id });
  } else {
    await say(e, caption);
  }

  const materials = all('SELECT * FROM materials WHERE lesson_id=? ORDER BY id', lesson.id);
  if (materials.length) {
    const lines = materials.map((m) => `• ${m.title}: ${m.url || `${config.baseUrl}/uploads/${m.file}`}`);
    await say(e, `📎 *Practice material*\n${lines.join('\n')}`);
  }

  const progress = one('SELECT * FROM lesson_progress WHERE enrollment_id=? AND lesson_id=?', e.id, lesson.id);
  if (progress?.watched_at) {
    await say(e, `You already watched this lesson on the portal 👏 Let's practice.`);
    return askNext(e);
  }
  await poll(e, `Tap below once you've watched "${lesson.title}" 👇`, ['✅ I watched it'], `watch:${lesson.id}`);
}

async function askNext(e) {
  e = enrollment(e.id);
  const questions = questionsOf(e.current_lesson_id);
  const answered = new Set(all('SELECT question_id FROM answers WHERE enrollment_id=?', e.id).map((a) => a.question_id));
  const nextIdx = questions.findIndex((q) => !answered.has(q.id));
  if (nextIdx === -1) return finishLesson(e, questions);

  const q = questions[nextIdx];
  setState(e.id, { current_question_id: q.id, wa_state: 'quizzing' });
  const options = q.options.map((o, i) => `${LETTERS[i]}. ${o}`.slice(0, 100));
  await poll(e, `❓ Q${nextIdx + 1}/${questions.length}: ${q.prompt}`, options, `question:${q.id}`, { correctIndex: q.correct_index, explanation: q.explanation });
}

async function finishLesson(e, questions) {
  const lesson = one('SELECT * FROM lessons WHERE id=?', e.current_lesson_id);
  run(`INSERT OR IGNORE INTO lesson_progress (enrollment_id, lesson_id) VALUES (?,?)`, e.id, lesson.id);
  run(`UPDATE lesson_progress SET quiz_completed_at=COALESCE(quiz_completed_at, datetime('now')) WHERE enrollment_id=? AND lesson_id=?`, e.id, lesson.id);
  if (questions.length) {
    const correct = one(
      `SELECT COUNT(*) AS n FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.enrollment_id=? AND q.lesson_id=? AND a.is_correct=1`,
      e.id, lesson.id
    ).n;
    const pct = Math.round((correct / questions.length) * 100);
    const cheer = pct === 100 ? 'Perfect! 🌟' : pct >= 60 ? 'Nice work! 💪' : 'Keep going, review the lesson and you will nail it 🔁';
    await say(e, `🏁 *${lesson.title}* complete — you scored *${correct}/${questions.length}* (${pct}%). ${cheer}`);
  }
  const next = one(
    `SELECT * FROM lessons WHERE course_id=? AND (position > ? OR (position = ? AND id > ?)) ORDER BY position, id LIMIT 1`,
    e.course_id, lesson.position, lesson.position, lesson.id
  );
  return deliverLesson(enrollment(e.id), next);
}

async function complete(e) {
  setState(e.id, { wa_state: 'done', current_question_id: null, completed_at: new Date().toISOString() });
  const course = one('SELECT * FROM courses WHERE id=?', e.course_id);
  const s = scoreFor(e.id);
  await say(
    enrollment(e.id),
    `🎓 *Congratulations!* You finished *${course.title}*.` +
      (s.total ? `\nOverall score: *${s.correct}/${s.total}* (${s.pct}%).` : '') +
      `\nYour full progress is on the portal: ${config.baseUrl}/learn/course/${course.id}`
  );
}

async function welcomeAndStart(e) {
  const user = one('SELECT * FROM users WHERE id=?', e.user_id);
  const course = one('SELECT c.*, u.name AS teacher_name FROM courses c JOIN users u ON u.id=c.teacher_id WHERE c.id=?', e.course_id);
  const n = lessonsOf(course.id).length;
  await say(
    e,
    `👋 Hi ${user.name.split(' ')[0]}! Welcome to *${course.title}* with ${course.teacher_name}.\n\n` +
      `Here's how it works:\n1️⃣ I send you a lesson video\n2️⃣ Tap "I watched it" when you're done\n3️⃣ Answer a few quick polls and get instant feedback\n\n` +
      `${n} lesson${n === 1 ? '' : 's'} ahead. Everything stays in sync with your portal: ${config.baseUrl}/learn/course/${course.id}`
  );
  // Resume where they were (e.g. after reconnecting Telegram), else lesson 1.
  const current = e.current_lesson_id && one('SELECT * FROM lessons WHERE id=?', e.current_lesson_id);
  await deliverLesson(enrollment(e.id), current || lessonsOf(course.id)[0]);
}

// ---------- public API ----------

/** Called right after a student enrolls: opens the WhatsApp group and starts lesson 1. */
export function startJourney(enrollmentId) {
  return enqueue(enrollmentId, async () => {
    let e = enrollment(enrollmentId);
    if (!e || (e.wa_chat_id && e.wa_state !== 'error')) return;
    const p = prov(e);
    if (!p) throw new Error(`${CHANNEL_LABEL[e.channel] || e.channel} is not configured`);
    const user = one('SELECT * FROM users WHERE id=?', e.user_id);
    const course = one('SELECT * FROM courses WHERE id=?', e.course_id);
    if (p.needsPhone !== false && !user.phone) throw new Error('Student has no WhatsApp number on their profile');

    if (!e.wa_chat_id) {
      const chat = await p.createChat({
        user,
        phone: user.phone,
        name: user.name,
        title: `${course.title} · ${user.name.split(' ')[0]}`.slice(0, 100),
      });
      setState(e.id, { wa_chat_id: chat.chatId, wa_invite_link: chat.inviteLink || null, wa_error: null });
      if (chat.pendingJoin) {
        setState(e.id, { wa_state: 'awaiting_join' });
        return;
      }
    }
    await welcomeAndStart(enrollment(e.id));
  });
}

/** Resume a journey that hit an error (e.g. phone was offline). */
export function retry(enrollmentId) {
  const e = enrollment(enrollmentId);
  if (!e || e.wa_state === 'stopped' || e.wa_state === 'done') return;
  if (!e.wa_chat_id || !e.current_lesson_id) {
    setState(e.id, { wa_state: 'pending', wa_error: null });
    return startJourney(enrollmentId);
  }
  return enqueue(enrollmentId, async () => {
    const cur = enrollment(enrollmentId);
    setState(cur.id, { wa_error: null });
    const lesson = one('SELECT * FROM lessons WHERE id=?', cur.current_lesson_id);
    const progress = one('SELECT * FROM lesson_progress WHERE enrollment_id=? AND lesson_id=?', cur.id, lesson.id);
    if (progress?.watched_at) await askNext(cur);
    else await deliverLesson(cur, lesson);
  });
}

/** The student finished a video (portal player or WhatsApp poll). */
export function watched(enrollmentId, lessonId, via) {
  const first = recordWatch(enrollmentId, lessonId, via);
  return enqueue(enrollmentId, async () => {
    const e = enrollment(enrollmentId);
    if (!e.wa_chat_id || e.wa_state !== 'awaiting_watch' || e.current_lesson_id !== lessonId) return;
    const n = questionsOf(lessonId).length;
    if (via === 'web' && first) await say(e, `👀 I see you finished the lesson on the portal.${n ? ' Time to practice!' : ''}`);
    else if (via !== 'web' && n) await say(e, `Great! Here ${n === 1 ? 'is 1 question' : `are ${n} quick questions`} 👇`);
    await askNext(e);
  });
}

/**
 * The student answered a question. Returns feedback synchronously for the portal;
 * the WhatsApp side (feedback + next poll) runs in the background.
 */
export function answer(enrollmentId, questionId, selectedIndex, via) {
  const result = recordAnswer(enrollmentId, questionId, selectedIndex, via);
  const { question: q, answer: a, isNew } = result;
  enqueue(enrollmentId, async () => {
    const e = enrollment(enrollmentId);
    if (!e.wa_chat_id) return;
    if (via !== 'web') {
      if (!isNew) {
        await say(e, `You already answered that one — your first answer (${LETTERS[a.selected_index]}) counts.`);
        return;
      }
      await sendFeedback(e, q, a);
    } else if (isNew && e.current_question_id === q.id) {
      await say(e, `📝 Answered on the portal: ${a.is_correct ? '✅ correct' : '❌ not quite'}.`);
    }
    if (e.wa_state === 'quizzing' && e.current_question_id === q.id) await askNext(e);
  });
  return result;
}

export function feedbackText(q, a, p = providers.whatsapp) {
  const right = `${LETTERS[q.correct_index]}. ${q.options[q.correct_index]}`;
  let text = a.is_correct ? `✅ *Correct!*` : `❌ *Not quite.* The right answer is *${right}*.`;
  if (q.explanation) text += `\n💡 ${q.explanation}`;
  if (q.explanation_url) text += `\n🔗 Explanation: ${q.explanation_url}`;
  if (q.explanation_file && !sendsExplanationVideo(q, p)) text += `\n📎 Explanation: ${config.baseUrl}/uploads/${q.explanation_file}`;
  return text;
}

const isVideo = (f) => /\.(mp4|m4v|mov|webm)$/i.test(f || '');
function sendsExplanationVideo(q, p) {
  return Boolean(p?.sendVideo && isVideo(q.explanation_file) && q.explanation_file_size && q.explanation_file_size <= maxVideoBytes(p));
}

/** Native quiz polls (Telegram) already show right/wrong + a short explanation. */
export const NATIVE_EXPLANATION_MAX = 200;
function extraExplanation(q, p) {
  const lines = [];
  if (q.explanation && q.explanation.length > NATIVE_EXPLANATION_MAX) lines.push(`💡 ${q.explanation}`);
  if (q.explanation_url) lines.push(`🔗 Explanation: ${q.explanation_url}`);
  if (q.explanation_file && !sendsExplanationVideo(q, p)) lines.push(`📎 Explanation: ${config.baseUrl}/uploads/${q.explanation_file}`);
  return lines.join('\n');
}

async function sendFeedback(e, q, a) {
  const p = prov(e);
  if (p.nativeQuiz) {
    const extra = extraExplanation(q, p);
    if (extra) await say(e, extra);
  } else {
    await say(e, feedbackText(q, a, p));
  }
  if (sendsExplanationVideo(q, p)) {
    const caption = '🎬 Explanation';
    await pace(e);
    const r = await p.sendVideo(e.wa_chat_id, {
      filePath: `${config.uploadDir}/${q.explanation_file}`,
      url: `${config.baseUrl}/uploads/${q.explanation_file}`,
      caption,
    });
    log(e.id, 'out', 'video', { caption, video: `/uploads/${q.explanation_file}` }, { externalId: r?.id });
  }
}

/**
 * Events coming from a provider (evt.channel says which one; defaults to whatsapp):
 *   { type: 'vote', pollId, optionIndex }  a student voted in a poll / tapped a button
 *   { type: 'joined', chatId }             the student joined / opened the chat
 *   { type: 'start', chatId, payload, username }  Telegram /start <link token>
 *   { type: 'text', chatId, text }         free text from the student
 *   { type: 'left', chatId }               the student left the group
 */
export async function handleInbound(evt) {
  const channel = evt.channel || 'whatsapp';
  if (evt.type === 'vote') {
    const msg = one(
      `SELECT w.* FROM wa_messages w JOIN enrollments e ON e.id=w.enrollment_id WHERE w.external_id=? AND w.kind='poll' AND e.channel=?`,
      evt.pollId, channel
    );
    if (!msg) return;
    const body = JSON.parse(msg.body);
    log(msg.enrollment_id, 'in', 'vote', { option: body.options[evt.optionIndex], pollId: evt.pollId });
    const [kind, id] = msg.ref.split(':');
    if (kind === 'watch') return watched(msg.enrollment_id, Number(id), channel);
    if (kind === 'question') return answer(msg.enrollment_id, Number(id), evt.optionIndex, channel);
  }
  if (evt.type === 'start') return linkTelegram(evt);
  if (evt.type === 'joined') {
    const waiting = all(`SELECT * FROM enrollments WHERE wa_chat_id=? AND channel=? AND wa_state='awaiting_join'`, evt.chatId, channel);
    for (const e of waiting) {
      setState(e.id, { wa_state: 'pending' });
      enqueue(e.id, () => welcomeAndStart(enrollment(e.id)));
    }
  }
  if (evt.type === 'text') {
    const cmd = evt.text.trim().replace(/^\//, '').toUpperCase();
    // A chat can carry several courses (Telegram, Cloud API): commands apply to all of them.
    const list = all(`SELECT * FROM enrollments WHERE wa_chat_id=? AND channel=? ORDER BY id DESC`, evt.chatId, channel);
    if (!list.length) return;
    log(list[0].id, 'in', 'text', { text: evt.text });
    if (['STOP', 'UNSUBSCRIBE', 'PAUSE'].includes(cmd)) for (const e of list) stop(e.id, channel);
    if (['START', 'RESUME', 'CONTINUE'].includes(cmd)) for (const e of list) resume(e.id);
  }
  if (evt.type === 'left') {
    for (const e of all(`SELECT * FROM enrollments WHERE wa_chat_id=? AND channel=? AND wa_state NOT IN ('done','stopped')`, evt.chatId, channel)) {
      setState(e.id, { wa_state: 'stopped', wa_error: `The student left the ${CHANNEL_LABEL[channel]} chat.` });
    }
  }
}

/**
 * Telegram deep link: t.me/<bot>?start=<token>. Links the Telegram chat to the
 * Laqtin user that owns the token, then starts any journeys waiting for it.
 */
async function linkTelegram(evt) {
  const p = providers.telegram;
  if (!p) return;
  const token = String(evt.payload || '').trim();
  let user = token ? one('SELECT * FROM users WHERE telegram_link_token=?', token) : null;
  if (!user) user = one('SELECT * FROM users WHERE telegram_chat_id=?', String(evt.chatId));
  if (!user) {
    await p.sendText(evt.chatId, `👋 This is the Laqtin academy bot.\nTo get your lessons here, open your course on ${config.baseUrl} and tap *Connect Telegram*.`);
    return;
  }
  const other = one('SELECT id FROM users WHERE telegram_chat_id=? AND id<>?', String(evt.chatId), user.id);
  if (other) run('UPDATE users SET telegram_chat_id=NULL, telegram_username=NULL WHERE id=?', other.id);
  run('UPDATE users SET telegram_chat_id=?, telegram_username=? WHERE id=?', String(evt.chatId), evt.username || null, user.id);

  const waiting = all(`SELECT * FROM enrollments WHERE user_id=? AND channel='telegram' AND wa_state IN ('awaiting_join','error','pending')`, user.id);
  if (!waiting.length) {
    const paused = all(`SELECT * FROM enrollments WHERE user_id=? AND channel='telegram' AND wa_state='stopped'`, user.id);
    if (paused.length) {
      for (const e of paused) resume(e.id);
      return;
    }
    await p.sendText(evt.chatId, `✅ Telegram connected, ${user.name.split(' ')[0]}! Enroll in a course on ${config.baseUrl}/courses and choose Telegram to learn here.`);
    return;
  }
  for (const e of waiting) {
    setState(e.id, { wa_chat_id: String(evt.chatId), wa_state: 'pending', wa_error: null });
    enqueue(e.id, () => welcomeAndStart(enrollment(e.id)));
  }
}

/** Pause WhatsApp delivery (student request, STOP keyword). Progress is kept. */
export function stop(enrollmentId, via = 'web') {
  const e = enrollment(enrollmentId);
  if (!e || e.wa_state === 'stopped' || e.wa_state === 'done') return;
  setState(e.id, { wa_state: 'stopped', wa_error: null });
  if (!e.wa_chat_id || !prov(e)) return;
  return enqueue(
    e.id,
    () =>
      say(
        enrollment(e.id),
        `⏸️ Paused *${one('SELECT title FROM courses WHERE id=?', e.course_id).title}* — I won't send more messages${via === 'web' ? '' : ' here'}. Reply *START* or use the portal whenever you want to continue: ${config.baseUrl}/learn/course/${e.course_id}`
      ),
    { evenIfStopped: true }
  );
}

/** Resume a paused journey from where the student left off. */
export function resume(enrollmentId) {
  const e = enrollment(enrollmentId);
  if (!e || e.wa_state !== 'stopped') return;
  if (!e.wa_chat_id || !e.current_lesson_id) {
    setState(e.id, { wa_state: 'pending', wa_error: null });
    return startJourney(e.id);
  }
  setState(e.id, { wa_state: 'awaiting_watch', wa_error: null });
  return enqueue(e.id, async () => {
    const cur = enrollment(e.id);
    await say(cur, `▶️ Welcome back! Let's pick up where you left off.`);
    const progress = one('SELECT * FROM lesson_progress WHERE enrollment_id=? AND lesson_id=?', cur.id, cur.current_lesson_id);
    if (progress?.watched_at) await askNext(cur);
    else await deliverLesson(cur, one('SELECT * FROM lessons WHERE id=?', cur.current_lesson_id));
  });
}

/** Restart journeys interrupted by a server restart. */
export function recoverInterrupted() {
  for (const e of all(`SELECT id FROM enrollments WHERE wa_state='pending'`)) startJourney(e.id);
}

/**
 * Gentle reminders for students who have gone quiet: one nudge per quiet period,
 * at most config.whatsapp.maxReminders in a row until they make progress again.
 */
export async function sendReminders() {
  const { reminderHours: hours, maxReminders } = config.whatsapp;
  if (!hours) return 0;
  const due = all(
    `SELECT e.* FROM enrollments e
      WHERE e.wa_state IN ('awaiting_watch','quizzing') AND e.wa_chat_id IS NOT NULL AND e.nudge_count < ?
        AND (SELECT MAX(created_at) FROM wa_messages w WHERE w.enrollment_id=e.id) <= datetime('now', ?)`,
    maxReminders, `-${hours} hours`
  );
  for (const e of due) {
    run('UPDATE enrollments SET nudge_count=nudge_count+1 WHERE id=?', e.id);
    enqueue(e.id, async () => {
      const cur = enrollment(e.id);
      const lesson = one('SELECT * FROM lessons WHERE id=?', cur.current_lesson_id);
      if (cur.wa_state === 'awaiting_watch') {
        await say(cur, `⏰ Your lesson *${lesson.title}* is waiting for you — a few minutes is all it takes.\n▶️ ${lessonLink(lesson)}\n\n(Reply STOP to pause these messages.)`);
      } else if (cur.wa_state === 'quizzing') {
        await say(cur, `⏰ You have a practice question waiting above 👆 Tap an answer to keep going.\n\n(Reply STOP to pause these messages.)`);
      }
    });
  }
  return due.length;
}

// ---------- reporting helpers used by the portal ----------

export function scoreFor(enrollmentId, lessonId = null) {
  const params = lessonId ? [enrollmentId, lessonId] : [enrollmentId];
  const row = one(
    `SELECT COUNT(*) AS total, COALESCE(SUM(a.is_correct),0) AS correct
       FROM answers a JOIN questions q ON q.id=a.question_id
      WHERE a.enrollment_id=? ${lessonId ? 'AND q.lesson_id=?' : ''}`,
    ...params
  );
  return { ...row, pct: row.total ? Math.round((row.correct / row.total) * 100) : 0 };
}
