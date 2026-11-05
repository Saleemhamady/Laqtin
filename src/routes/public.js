import { Router } from 'express';
import { one, all, run } from '../db.js';
import { courseWithTeacher, normalizePhone } from '../lib.js';
import { requireUser, HttpError } from '../middleware.js';
import { startJourney, getProvider } from '../whatsapp/engine.js';

const r = Router();

r.get('/healthz', (req, res) => {
  one('SELECT 1 AS ok');
  res.json({ ok: true });
});

r.get('/privacy', (req, res) => res.render('legal', { title: 'Privacy Policy', kind: 'privacy' }));
r.get('/terms', (req, res) => res.render('legal', { title: 'Terms of Service', kind: 'terms' }));

const COURSE_LIST = `
  SELECT c.*, u.name AS teacher_name,
         (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) AS lesson_count,
         (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) AS student_count
    FROM courses c JOIN users u ON u.id=c.teacher_id
   WHERE c.published=1`;

r.get('/', (req, res) => {
  const courses = all(`${COURSE_LIST} ORDER BY c.created_at DESC LIMIT 6`);
  res.render('home', { title: null, courses });
});

r.get('/courses', (req, res) => {
  const q = String(req.query.q || '').trim();
  const courses = q
    ? all(`${COURSE_LIST} AND (c.title LIKE ? OR c.summary LIKE ? OR u.name LIKE ?) ORDER BY c.title`, `%${q}%`, `%${q}%`, `%${q}%`)
    : all(`${COURSE_LIST} ORDER BY c.created_at DESC`);
  res.render('courses', { title: 'Courses', courses, q });
});

r.get('/courses/:id', (req, res) => {
  const course = courseWithTeacher(Number(req.params.id));
  const canPreview = course && req.user && (req.user.role === 'admin' || req.user.id === course.teacher_id);
  if (!course || (!course.published && !canPreview)) throw new HttpError(404, 'Course not found');
  const lessons = all(
    `SELECT l.*, (SELECT COUNT(*) FROM questions q WHERE q.lesson_id=l.id) AS question_count
       FROM lessons l WHERE l.course_id=? ORDER BY position, id`,
    course.id
  );
  const enrollment = req.user ? one('SELECT * FROM enrollments WHERE user_id=? AND course_id=?', req.user.id, course.id) : null;
  res.render('course', { title: course.title, course, lessons, enrollment });
});

r.post('/courses/:id/enroll', requireUser, (req, res) => {
  const course = one('SELECT * FROM courses WHERE id=? AND published=1', Number(req.params.id));
  if (!course) throw new HttpError(404, 'Course not found');
  const existing = one('SELECT * FROM enrollments WHERE user_id=? AND course_id=?', req.user.id, course.id);
  if (existing) return res.redirect(`/learn/course/${course.id}`);

  const channel = req.body.channel === 'telegram' && getProvider('telegram') ? 'telegram' : 'whatsapp';
  let phone = req.user.phone;
  if (req.body.phone) {
    phone = normalizePhone(req.body.phone);
    if (!phone) {
      req.flash('error', 'Enter your WhatsApp number with the country code, e.g. +971 50 123 4567.');
      return res.redirect(`/courses/${course.id}`);
    }
    run('UPDATE users SET phone=? WHERE id=?', phone, req.user.id);
  }
  if (channel === 'whatsapp' && !phone) {
    req.flash('error', 'Add your WhatsApp number to enroll — that’s where your lessons arrive.');
    return res.redirect(`/courses/${course.id}`);
  }
  const { lastInsertRowid } = run('INSERT INTO enrollments (user_id, course_id, channel) VALUES (?,?,?)', req.user.id, course.id, channel);
  startJourney(Number(lastInsertRowid));
  const linked = channel === 'telegram' && one('SELECT telegram_chat_id FROM users WHERE id=?', req.user.id).telegram_chat_id;
  req.flash(
    'success',
    channel === 'whatsapp' ? 'You’re in! Your first lesson is on its way to WhatsApp.' : linked ? 'You’re in! Your first lesson is on its way to Telegram.' : 'You’re in! Connect Telegram to get your first lesson.'
  );
  res.redirect(`/learn/course/${course.id}`);
});

export default r;
