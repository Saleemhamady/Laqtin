import { Router } from 'express';
import crypto from 'node:crypto';
import { one, all, run } from '../db.js';
import { config } from '../config.js';
import { courseProgress, courseWithTeacher, videoEmbed } from '../lib.js';
import { requireUser, HttpError, fileKind } from '../middleware.js';
import * as engine from '../whatsapp/engine.js';
import { readLink } from '../links.js';

const r = Router();

function myEnrollment(userId, courseId) {
  const e = one('SELECT * FROM enrollments WHERE user_id=? AND course_id=?', userId, courseId);
  if (!e) throw new HttpError(403, 'Enroll in this course to see its lessons.');
  return e;
}

/** Enrollment visible to the user: their own, or one in a course they teach. */
function visibleEnrollment(user, id) {
  const e = one('SELECT e.*, c.teacher_id FROM enrollments e JOIN courses c ON c.id=e.course_id WHERE e.id=?', id);
  if (!e || (e.user_id !== user.id && e.teacher_id !== user.id && user.role !== 'admin')) throw new HttpError(404, 'Not found');
  return e;
}

// Personal links from WhatsApp/Telegram messages (see src/links.js).
r.get('/l/:token', (req, res) => {
  const link = readLink(req.params.token);
  if (!link) return res.status(400).render('error', { title: 'Link not valid', message: 'This link isn’t valid. Open the latest message from Laqtine, or sign in.' });
  const e = one('SELECT * FROM enrollments WHERE id=?', link.enrollmentId);
  if (!e) return res.status(404).render('error', { title: 'Not found', message: 'This course enrollment no longer exists.' });
  const lesson = link.lessonId ? one('SELECT * FROM lessons WHERE id=? AND course_id=?', link.lessonId, e.course_id) : null;
  const target = lesson ? `/learn/lesson/${lesson.id}` : `/learn/course/${e.course_id}`;
  if (req.user?.id === e.user_id) return res.redirect(target);

  const user = one('SELECT * FROM users WHERE id=?', e.user_id);
  if (link.expired || user.role !== 'student') {
    // Expired links, and teacher/admin accounts, always need a real sign-in.
    req.session.returnTo = target;
    if (link.expired) req.flash('error', 'That link has expired — please sign in to continue.');
    return res.redirect('/login');
  }
  req.session.uid = user.id;
  req.session.viaLink = true;
  req.session.csrf = null;
  res.redirect(target);
});

r.get('/learn', requireUser, (req, res) => {
  const enrollments = all(
    `SELECT e.*, c.title, c.summary, c.color, u.name AS teacher_name
       FROM enrollments e JOIN courses c ON c.id=e.course_id JOIN users u ON u.id=c.teacher_id
      WHERE e.user_id=? ORDER BY e.created_at DESC`,
    req.user.id
  ).map((e) => ({ ...e, progress: courseProgress(e.id, e.course_id) }));
  res.render('student/dashboard', { title: 'My learning', enrollments });
});

r.get('/learn/course/:id', requireUser, (req, res) => {
  const course = courseWithTeacher(Number(req.params.id));
  if (!course) throw new HttpError(404, 'Course not found');
  const enrollment = myEnrollment(req.user.id, course.id);
  const progress = courseProgress(enrollment.id, course.id);
  const next = progress.lessons.find((l) => !l.complete) || progress.lessons[0];
  res.render('student/course', { title: course.title, course, enrollment, progress, next });
});

r.get('/learn/lesson/:id', requireUser, (req, res) => {
  const lesson = one('SELECT * FROM lessons WHERE id=?', Number(req.params.id));
  if (!lesson) throw new HttpError(404, 'Lesson not found');
  const course = courseWithTeacher(lesson.course_id);
  const isOwner = req.user.role === 'admin' || req.user.id === course.teacher_id;
  const enrollment = isOwner ? one('SELECT * FROM enrollments WHERE user_id=? AND course_id=?', req.user.id, course.id) : myEnrollment(req.user.id, course.id);
  const progress = enrollment ? courseProgress(enrollment.id, course.id) : null;
  const lessons = all('SELECT * FROM lessons WHERE course_id=? ORDER BY position, id', course.id);
  const idx = lessons.findIndex((l) => l.id === lesson.id);
  const row = progress?.lessons.find((l) => l.lesson.id === lesson.id);
  const questions = row?.questions || all('SELECT * FROM questions WHERE lesson_id=? ORDER BY position, id', lesson.id).map((q) => ({ ...q, options: JSON.parse(q.options) }));
  const materials = all('SELECT * FROM materials WHERE lesson_id=? ORDER BY id', lesson.id);
  res.render('student/lesson', {
    title: lesson.title,
    course,
    lesson,
    lessons,
    idx,
    prev: lessons[idx - 1],
    next: lessons[idx + 1],
    video: videoEmbed(lesson),
    materials,
    questions,
    row,
    progress,
    enrollment,
    preview: !enrollment,
  });
});

// Telegram: give the user a one-time link token and send them to the bot.
r.get('/telegram/connect', requireUser, (req, res) => {
  const tg = engine.getProvider('telegram');
  if (!tg) throw new HttpError(404, 'Telegram isn’t enabled on this academy.');
  let { telegram_link_token: token } = one('SELECT telegram_link_token FROM users WHERE id=?', req.user.id);
  if (!token) {
    token = crypto.randomBytes(18).toString('base64url');
    run('UPDATE users SET telegram_link_token=? WHERE id=?', token, req.user.id);
  }
  const url = tg.linkUrl(token);
  if (!url) {
    req.flash('error', 'The Telegram bot isn’t connected right now. Please try again in a minute.');
    return res.redirect(req.get('referer')?.startsWith(config.baseUrl) ? req.get('referer') : '/learn');
  }
  res.redirect(url);
});

r.post('/telegram/disconnect', requireUser, (req, res) => {
  run('UPDATE users SET telegram_chat_id=NULL, telegram_username=NULL, telegram_link_token=NULL WHERE id=?', req.user.id);
  // Courses delivered on Telegram wait for the student to connect again.
  run(
    `UPDATE enrollments SET wa_chat_id=NULL, wa_state='awaiting_join', wa_error=NULL
      WHERE user_id=? AND channel='telegram' AND wa_state NOT IN ('done')`,
    req.user.id
  );
  req.flash('success', 'Telegram disconnected.');
  res.redirect('/profile');
});

r.post('/learn/course/:id/pause', requireUser, (req, res) => {
  const e = myEnrollment(req.user.id, Number(req.params.id));
  engine.stop(e.id, 'web');
  req.flash('success', 'WhatsApp messages paused. Your progress is saved.');
  res.redirect(`/learn/course/${e.course_id}`);
});

r.post('/learn/course/:id/resume', requireUser, (req, res) => {
  const e = myEnrollment(req.user.id, Number(req.params.id));
  engine.resume(e.id);
  req.flash('success', 'Welcome back! Your next message is on its way.');
  res.redirect(`/learn/course/${e.course_id}`);
});

// ---------- JSON API used by the lesson player and the WhatsApp mirror ----------

r.post('/api/lessons/:id/watched', requireUser, (req, res) => {
  const lesson = one('SELECT * FROM lessons WHERE id=?', Number(req.params.id));
  if (!lesson) throw new HttpError(404, 'Lesson not found');
  const e = myEnrollment(req.user.id, lesson.course_id);
  engine.watched(e.id, lesson.id, 'web');
  res.json({ ok: true });
});

r.post('/api/lessons/:id/position', requireUser, (req, res) => {
  const lesson = one('SELECT * FROM lessons WHERE id=?', Number(req.params.id));
  if (!lesson) throw new HttpError(404, 'Lesson not found');
  const e = myEnrollment(req.user.id, lesson.course_id);
  const seconds = Math.max(0, Math.min(Number(req.body.seconds) || 0, 24 * 3600));
  run('INSERT OR IGNORE INTO lesson_progress (enrollment_id, lesson_id) VALUES (?,?)', e.id, lesson.id);
  run('UPDATE lesson_progress SET position_seconds=? WHERE enrollment_id=? AND lesson_id=?', seconds, e.id, lesson.id);
  res.json({ ok: true });
});

r.post('/api/questions/:id/answer', requireUser, (req, res) => {
  const q = one('SELECT q.*, l.course_id FROM questions q JOIN lessons l ON l.id=q.lesson_id WHERE q.id=?', Number(req.params.id));
  if (!q) throw new HttpError(404, 'Question not found');
  const e = myEnrollment(req.user.id, q.course_id);
  const { question, answer } = engine.answer(e.id, q.id, Number(req.body.index), 'web');
  res.json({
    correct: Boolean(answer.is_correct),
    selected: answer.selected_index,
    correctIndex: question.correct_index,
    explanation: question.explanation,
    explanationFile: question.explanation_file
      ? { url: `/uploads/${question.explanation_file}`, name: question.explanation_file_name, kind: fileKind(question.explanation_file) }
      : null,
    explanationEmbed: question.explanation_url ? videoEmbed({ video_url: question.explanation_url }) : null,
  });
});

r.get('/api/enrollments/:id/messages', requireUser, (req, res) => {
  const e = visibleEnrollment(req.user, Number(req.params.id));
  const after = Number(req.query.after || 0);
  // Quiz results are attached only once answered, so the mirror never leaks answers.
  const answered = new Map(
    all(
      `SELECT a.question_id, a.selected_index, q.correct_index, q.explanation FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.enrollment_id=?`,
      e.id
    ).map((a) => [a.question_id, a])
  );
  // Re-send polls (after=0) so verdicts show up on polls the page already has.
  const messages = all('SELECT id, direction, kind, body, ref, external_id, created_at FROM wa_messages WHERE enrollment_id=? AND id>? ORDER BY id', e.id, after).map((m) => {
    const out = { ...m, body: JSON.parse(m.body) };
    const qid = m.ref?.startsWith('question:') && Number(m.ref.slice(9));
    const a = qid && answered.get(qid);
    if (a) out.result = { correctIndex: a.correct_index, selected: a.selected_index, explanation: a.explanation };
    return out;
  });
  const results = Object.fromEntries([...answered].map(([qid, a]) => [`question:${qid}`, { correctIndex: a.correct_index, selected: a.selected_index, explanation: a.explanation }]));
  const fresh = one('SELECT wa_state, wa_error, current_question_id, current_lesson_id, channel FROM enrollments WHERE id=?', e.id);
  res.json({ messages, state: fresh, results });
});

// Simulator only: tapping a poll option in the portal's WhatsApp preview.
r.post('/api/enrollments/:id/simulate-vote', requireUser, async (req, res) => {
  const e = visibleEnrollment(req.user, Number(req.params.id));
  if (!engine.getProvider(e.channel)?.interactiveMirror) throw new HttpError(400, 'Only available in simulator mode');
  if (e.user_id !== req.user.id) throw new HttpError(403, 'Only the student can vote');
  const msg = one(`SELECT * FROM wa_messages WHERE id=? AND enrollment_id=? AND kind='poll'`, Number(req.body.messageId), e.id);
  if (!msg) throw new HttpError(404, 'Poll not found');
  await engine.handleInbound({ type: 'vote', channel: e.channel, pollId: msg.external_id, optionIndex: Number(req.body.optionIndex) });
  res.json({ ok: true });
});

export default r;
