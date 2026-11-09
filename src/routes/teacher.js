import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';
import { one, all, run, tx, parseQuestion } from '../db.js';
import { courseProgress, courseWithTeacher, videoEmbed } from '../lib.js';
import { requireRole, HttpError, videoUpload, materialUpload, explanationUpload, fileKind } from '../middleware.js';
import multer from 'multer';
import * as engine from '../whatsapp/engine.js';
import * as stream from '../stream.js';

const r = Router();
r.use(requireRole('teacher', 'admin'));

const COLORS = ['#0f766e', '#1d4ed8', '#7c3aed', '#be123c', '#c2410c', '#4d7c0f', '#0e7490', '#334155'];

function removeUpload(name) {
  if (!name) return;
  const p = path.join(config.uploadDir, path.basename(name));
  fs.promises.unlink(p).catch(() => {});
}

function ownCourse(req, id) {
  const c = courseWithTeacher(Number(id));
  if (!c || (c.teacher_id !== req.user.id && req.user.role !== 'admin')) throw new HttpError(404, 'Course not found');
  return c;
}
function ownLesson(req, id) {
  const l = one('SELECT * FROM lessons WHERE id=?', Number(id));
  if (!l) throw new HttpError(404, 'Lesson not found');
  ownCourse(req, l.course_id);
  return l;
}
function ownQuestion(req, id) {
  const q = one('SELECT * FROM questions WHERE id=?', Number(id));
  if (!q) throw new HttpError(404, 'Question not found');
  return { question: parseQuestion(q), lesson: ownLesson(req, q.lesson_id) };
}

const str = (v, max = 5000) => String(v ?? '').trim().slice(0, max);
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const cleanUrl = (v) => {
  const s = str(v, 1000);
  if (!s) return null;
  try {
    const u = new URL(s);
    return ['http:', 'https:'].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
};

// ---------- courses ----------

r.get('/', (req, res) => {
  const where = req.user.role === 'admin' && req.query.all ? '' : 'WHERE c.teacher_id=?';
  const params = where ? [req.user.id] : [];
  const courses = all(
    `SELECT c.*, (SELECT COUNT(*) FROM lessons l WHERE l.course_id=c.id) AS lesson_count,
            (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id) AS student_count,
            (SELECT COUNT(*) FROM enrollments e WHERE e.course_id=c.id AND e.wa_state='done') AS completed_count
       FROM courses c ${where} ORDER BY c.created_at DESC`,
    ...params
  );
  res.render('teacher/dashboard', { title: 'Teaching', courses });
});

r.get('/courses/new', (req, res) => {
  res.render('teacher/course-form', { title: 'New course', course: { color: COLORS[Math.floor(Math.random() * COLORS.length)] }, colors: COLORS });
});

function courseFields(body) {
  return {
    title: str(body.title, 120),
    summary: str(body.summary, 200),
    description: str(body.description),
    color: COLORS.includes(body.color) ? body.color : COLORS[0],
  };
}

r.post('/courses', (req, res) => {
  const f = courseFields(req.body);
  if (!f.title) return res.status(400).render('teacher/course-form', { title: 'New course', course: f, colors: COLORS, error: 'Give your course a title.' });
  const { lastInsertRowid } = run('INSERT INTO courses (teacher_id, title, summary, description, color) VALUES (?,?,?,?,?)', req.user.id, f.title, f.summary, f.description, f.color);
  req.flash('success', 'Course created. Add your first lesson.');
  res.redirect(`/teach/courses/${lastInsertRowid}`);
});

r.get('/courses/:id', (req, res) => {
  const course = ownCourse(req, req.params.id);
  const tab = ['content', 'students', 'settings'].includes(req.query.tab) ? req.query.tab : 'content';
  const lessons = all(
    `SELECT l.*, (SELECT COUNT(*) FROM questions q WHERE q.lesson_id=l.id) AS question_count,
            (SELECT COUNT(*) FROM materials m WHERE m.lesson_id=l.id) AS material_count
       FROM lessons l WHERE l.course_id=? ORDER BY position, id`,
    course.id
  );
  const students =
    tab === 'students'
      ? all(
          `SELECT e.*, u.name, u.email, u.phone, (SELECT MAX(created_at) FROM wa_messages w WHERE w.enrollment_id=e.id) AS last_activity
             FROM enrollments e JOIN users u ON u.id=e.user_id WHERE e.course_id=? ORDER BY e.created_at DESC`,
          course.id
        ).map((s) => ({ ...s, progress: courseProgress(s.id, course.id) }))
      : [];
  res.render('teacher/course', { title: course.title, course, lessons, students, tab, colors: COLORS });
});

r.post('/courses/:id', (req, res) => {
  const course = ownCourse(req, req.params.id);
  const f = courseFields(req.body);
  if (!f.title) {
    req.flash('error', 'The course needs a title.');
    return res.redirect(`/teach/courses/${course.id}?tab=settings`);
  }
  run('UPDATE courses SET title=?, summary=?, description=?, color=? WHERE id=?', f.title, f.summary, f.description, f.color, course.id);
  req.flash('success', 'Course details saved.');
  res.redirect(`/teach/courses/${course.id}?tab=settings`);
});

r.post('/courses/:id/publish', (req, res) => {
  const course = ownCourse(req, req.params.id);
  const publish = req.body.publish === '1';
  if (publish && course.lesson_count === 0) {
    req.flash('error', 'Add at least one lesson before publishing.');
  } else {
    run('UPDATE courses SET published=? WHERE id=?', publish ? 1 : 0, course.id);
    req.flash('success', publish ? 'Published — students can now enroll.' : 'Unpublished. Enrolled students keep access.');
  }
  res.redirect(`/teach/courses/${course.id}`);
});

r.post('/courses/:id/delete', (req, res) => {
  const course = ownCourse(req, req.params.id);
  if (course.student_count > 0) {
    req.flash('error', 'This course has students, so it can’t be deleted. Unpublish it instead.');
    return res.redirect(`/teach/courses/${course.id}?tab=settings`);
  }
  for (const l of all('SELECT * FROM lessons WHERE course_id=?', course.id)) deleteLessonFiles(l);
  run('DELETE FROM courses WHERE id=?', course.id);
  req.flash('success', 'Course deleted.');
  res.redirect('/teach');
});

// ---------- students ----------

r.get('/enrollments/:id', (req, res) => {
  const e = one('SELECT * FROM enrollments WHERE id=?', Number(req.params.id));
  if (!e) throw new HttpError(404, 'Not found');
  const course = ownCourse(req, e.course_id);
  const student = one('SELECT id, name, email, phone FROM users WHERE id=?', e.user_id);
  res.render('teacher/enrollment', { title: student.name, course, e, student, progress: courseProgress(e.id, course.id) });
});

r.post('/enrollments/:id/retry', (req, res) => {
  const e = one('SELECT * FROM enrollments WHERE id=?', Number(req.params.id));
  if (!e) throw new HttpError(404, 'Not found');
  ownCourse(req, e.course_id);
  engine.retry(e.id);
  req.flash('success', 'Retrying WhatsApp delivery.');
  res.redirect(req.get('referer')?.startsWith(config.baseUrl) ? req.get('referer') : `/teach/enrollments/${e.id}`);
});

// ---------- lessons ----------

r.post('/courses/:id/lessons', (req, res) => {
  const course = ownCourse(req, req.params.id);
  const title = str(req.body.title, 160) || 'Untitled lesson';
  const pos = one('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM lessons WHERE course_id=?', course.id).p;
  const { lastInsertRowid } = run('INSERT INTO lessons (course_id, position, title) VALUES (?,?,?)', course.id, pos, title);
  res.redirect(`/teach/lessons/${lastInsertRowid}`);
});

r.get('/lessons/:id', async (req, res) => {
  const lesson = ownLesson(req, req.params.id);
  const course = ownCourse(req, lesson.course_id);
  const lessons = all('SELECT id, title, position FROM lessons WHERE course_id=? ORDER BY position, id', course.id);
  const questions = all('SELECT * FROM questions WHERE lesson_id=? ORDER BY position, id', lesson.id).map((q) => ({
    ...parseQuestion(q),
    explanation_kind: q.explanation_file ? fileKind(q.explanation_file) : null,
  }));
  const materials = all('SELECT * FROM materials WHERE lesson_id=? ORDER BY id', lesson.id).map((m) => ({ ...m, kind: m.file ? fileKind(m.file) : 'link' }));
  res.render('teacher/lesson', {
    title: lesson.title,
    course,
    lesson,
    lessons,
    questions,
    materials,
    video: videoEmbed(lesson),
    editId: Number(req.query.edit) || null,
    maxUploadMb: config.maxUploadMb,
    captions: lesson.stream_uid && lesson.stream_state === 'ready' ? await stream.listCaptions(lesson.stream_uid).catch(() => null) : null,
    CAPTION_LANGS,
  });
});

// ---------- Cloudflare Stream ----------

const CAPTION_LANGS = { ar: 'Arabic', en: 'English', fr: 'French' };
const NO_STREAM = { stream_uid: null, stream_state: null, stream_hls: null, stream_thumbnail: null, stream_duration: null };
const setLesson = (id, fields) => {
  const keys = Object.keys(fields);
  run(`UPDATE lessons SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=?`, ...keys.map((k) => fields[k]), id);
};

/** Step 1: the browser asks for a one-time upload URL, then uploads the file straight to Cloudflare. */
r.post('/lessons/:id/stream/upload', async (req, res) => {
  const lesson = ownLesson(req, req.params.id);
  if (!stream.streamEnabled()) throw new HttpError(400, 'Cloudflare Stream is not configured.');
  const course = one('SELECT title FROM courses WHERE id=?', lesson.course_id);
  const { uid, uploadURL } = await stream.createDirectUpload({ name: `${course.title} – ${lesson.title}` });
  if (lesson.stream_uid) stream.deleteVideo(lesson.stream_uid);
  removeUpload(lesson.video_file);
  setLesson(lesson.id, { ...NO_STREAM, stream_uid: uid, stream_state: 'uploading', video_file: null, video_size: null, video_url: null });
  res.json({ uploadURL, uid });
});

/** Step 2: check processing progress (the page polls this until the video is ready). */
r.post('/lessons/:id/stream/refresh', async (req, res) => {
  const lesson = ownLesson(req, req.params.id);
  if (!lesson.stream_uid) return res.json({ state: null });
  const v = await stream.getVideo(lesson.stream_uid);
  setLesson(lesson.id, { stream_state: v.state, stream_hls: v.hls, stream_thumbnail: v.thumbnail, stream_duration: v.duration });
  res.json({ state: v.state, pct: v.pct, error: v.error });
});

r.post('/lessons/:id/captions/generate', async (req, res) => {
  const lesson = ownLesson(req, req.params.id);
  const lang = CAPTION_LANGS[req.body.lang] ? req.body.lang : 'en';
  try {
    await stream.generateCaptions(lesson.stream_uid, lang);
    req.flash('success', `Generating ${CAPTION_LANGS[lang]} subtitles — they appear in a few minutes.`);
  } catch (err) {
    req.flash('error', `${err.message}. You can upload a subtitle file (.vtt) instead.`);
  }
  res.redirect(`/teach/lessons/${lesson.id}#video`);
});

const vttUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (/\.vtt$/i.test(file.originalname) ? cb(null, true) : cb(new HttpError(400, 'Subtitles must be a .vtt file.'))),
});

r.post('/lessons/:id/captions', vttUpload.single('vtt'), async (req, res) => {
  const lesson = ownLesson(req, req.params.id);
  const lang = CAPTION_LANGS[req.body.lang] ? req.body.lang : 'en';
  if (!req.file) {
    req.flash('error', 'Choose a .vtt subtitle file.');
  } else {
    try {
      await stream.uploadCaptions(lesson.stream_uid, lang, req.file.buffer);
      req.flash('success', `${CAPTION_LANGS[lang]} subtitles added.`);
    } catch (err) {
      req.flash('error', err.message);
    }
  }
  res.redirect(`/teach/lessons/${lesson.id}#video`);
});

r.post('/lessons/:id/captions/:lang/delete', async (req, res) => {
  const lesson = ownLesson(req, req.params.id);
  await stream.deleteCaptions(lesson.stream_uid, req.params.lang).catch((err) => req.flash('error', err.message));
  res.redirect(`/teach/lessons/${lesson.id}#video`);
});

r.post('/lessons/:id', videoUpload.single('video'), (req, res) => {
  const lesson = ownLesson(req, req.params.id);
  const title = str(req.body.title, 160) || lesson.title;
  const description = str(req.body.description);
  let { video_file, video_url, video_size } = lesson;
  let dropStream = false;
  if (req.file) {
    dropStream = true;
    removeUpload(video_file);
    video_file = req.file.filename;
    video_size = req.file.size;
    video_url = null;
  } else if (req.body.remove_video === '1') {
    dropStream = true;
    removeUpload(video_file);
    video_file = null;
    video_size = null;
    video_url = null;
  } else if (req.body.video_url !== undefined) {
    const url = cleanUrl(req.body.video_url);
    if (url && url !== video_url) {
      dropStream = true;
      removeUpload(video_file);
      video_file = null;
      video_size = null;
    }
    if (url || !video_file) video_url = url;
  }
  run('UPDATE lessons SET title=?, description=?, video_file=?, video_url=?, video_size=? WHERE id=?', title, description, video_file, video_url, video_size, lesson.id);
  if (dropStream && lesson.stream_uid) {
    stream.deleteVideo(lesson.stream_uid);
    setLesson(lesson.id, NO_STREAM);
  }
  req.flash('success', 'Lesson saved.');
  res.redirect(`/teach/lessons/${lesson.id}`);
});

r.post('/lessons/:id/move', (req, res) => {
  const lesson = ownLesson(req, req.params.id);
  const lessons = all('SELECT id FROM lessons WHERE course_id=? ORDER BY position, id', lesson.course_id).map((l) => l.id);
  const i = lessons.indexOf(lesson.id);
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < lessons.length) {
    [lessons[i], lessons[j]] = [lessons[j], lessons[i]];
    tx(() => lessons.forEach((id, k) => run('UPDATE lessons SET position=? WHERE id=?', k + 1, id)));
  }
  res.redirect(`/teach/courses/${lesson.course_id}`);
});

function deleteLessonFiles(lesson) {
  removeUpload(lesson.video_file);
  if (lesson.stream_uid) stream.deleteVideo(lesson.stream_uid);
  for (const m of all('SELECT file FROM materials WHERE lesson_id=?', lesson.id)) removeUpload(m.file);
  for (const q of all('SELECT explanation_file FROM questions WHERE lesson_id=?', lesson.id)) removeUpload(q.explanation_file);
}

r.post('/lessons/:id/delete', (req, res) => {
  const lesson = ownLesson(req, req.params.id);
  const inUse = one('SELECT COUNT(*) AS n FROM enrollments WHERE current_lesson_id=?', lesson.id).n;
  if (inUse) {
    req.flash('error', `${inUse} student${inUse === 1 ? ' is' : 's are'} on this lesson right now, so it can’t be deleted.`);
    return res.redirect(`/teach/lessons/${lesson.id}`);
  }
  deleteLessonFiles(lesson);
  run('DELETE FROM lessons WHERE id=?', lesson.id);
  req.flash('success', 'Lesson deleted.');
  res.redirect(`/teach/courses/${lesson.course_id}`);
});

// ---------- materials ----------

r.post('/lessons/:id/materials', materialUpload.single('file'), (req, res) => {
  const lesson = ownLesson(req, req.params.id);
  const url = cleanUrl(req.body.url);
  if (!req.file && !url) {
    req.flash('error', 'Choose a file or paste a link.');
    return res.redirect(`/teach/lessons/${lesson.id}#materials`);
  }
  const title = str(req.body.title, 160) || req.file?.originalname || url;
  run('INSERT INTO materials (lesson_id, title, file, url) VALUES (?,?,?,?)', lesson.id, title, req.file?.filename || null, req.file ? null : url);
  req.flash('success', 'Material added.');
  res.redirect(`/teach/lessons/${lesson.id}#materials`);
});

r.post('/materials/:id/delete', (req, res) => {
  const m = one('SELECT * FROM materials WHERE id=?', Number(req.params.id));
  if (!m) throw new HttpError(404, 'Not found');
  ownLesson(req, m.lesson_id);
  removeUpload(m.file);
  run('DELETE FROM materials WHERE id=?', m.id);
  res.redirect(`/teach/lessons/${m.lesson_id}#materials`);
});

// ---------- questions ----------

/** Parse the question builder form. Empty options are dropped and the correct answer re-mapped. */
function questionFields(body) {
  const raw = asArray(body.options).map((o) => str(o, 100));
  const correctRaw = Number(body.correct);
  const options = [];
  let correct = -1;
  raw.forEach((o, i) => {
    if (!o) return;
    if (i === correctRaw) correct = options.length;
    options.push(o);
  });
  const prompt = str(body.prompt, 240);
  let error = null;
  if (!prompt) error = 'Write the question.';
  else if (options.length < 2) error = 'Add at least two answer options.';
  else if (options.length > 10) error = 'Use at most 10 options.';
  else if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) error = 'Each option needs to be different.';
  else if (correct < 0) error = 'Mark which option is correct.';
  return { prompt, options, correct, explanation: str(body.explanation, 2000), explanationUrl: cleanUrl(body.explanation_url), error };
}

r.post('/lessons/:id/questions', explanationUpload.single('explanation_file'), (req, res) => {
  const lesson = ownLesson(req, req.params.id);
  const f = questionFields(req.body);
  if (f.error) {
    if (req.file) removeUpload(req.file.filename);
    req.flash('error', f.error);
    return res.redirect(`/teach/lessons/${lesson.id}#new-question`);
  }
  const pos = one('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM questions WHERE lesson_id=?', lesson.id).p;
  run(
    `INSERT INTO questions (lesson_id, position, prompt, options, correct_index, explanation, explanation_url, explanation_file, explanation_file_name, explanation_file_size)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    lesson.id, pos, f.prompt, JSON.stringify(f.options), f.correct, f.explanation, f.explanationUrl,
    req.file?.filename || null, req.file?.originalname?.slice(0, 200) || null, req.file?.size || null
  );
  req.flash('success', 'Question added.');
  res.redirect(`/teach/lessons/${lesson.id}#questions`);
});

r.post('/questions/:id', explanationUpload.single('explanation_file'), (req, res) => {
  const { question: q, lesson } = ownQuestion(req, req.params.id);
  const f = questionFields(req.body);
  if (f.error) {
    if (req.file) removeUpload(req.file.filename);
    req.flash('error', f.error);
    return res.redirect(`/teach/lessons/${lesson.id}?edit=${q.id}#q-${q.id}`);
  }
  let file = { name: q.explanation_file, original: q.explanation_file_name, size: q.explanation_file_size };
  if (req.file) {
    removeUpload(q.explanation_file);
    file = { name: req.file.filename, original: req.file.originalname.slice(0, 200), size: req.file.size };
  } else if (req.body.remove_explanation_file === '1') {
    removeUpload(q.explanation_file);
    file = { name: null, original: null, size: null };
  }
  run(
    `UPDATE questions SET prompt=?, options=?, correct_index=?, explanation=?, explanation_url=?, explanation_file=?, explanation_file_name=?, explanation_file_size=? WHERE id=?`,
    f.prompt, JSON.stringify(f.options), f.correct, f.explanation, f.explanationUrl, file.name, file.original, file.size, q.id
  );
  req.flash('success', 'Question saved.');
  res.redirect(`/teach/lessons/${lesson.id}#q-${q.id}`);
});

r.post('/questions/:id/move', (req, res) => {
  const { question: q, lesson } = ownQuestion(req, req.params.id);
  const ids = all('SELECT id FROM questions WHERE lesson_id=? ORDER BY position, id', lesson.id).map((x) => x.id);
  const i = ids.indexOf(q.id);
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < ids.length) {
    [ids[i], ids[j]] = [ids[j], ids[i]];
    tx(() => ids.forEach((id, k) => run('UPDATE questions SET position=? WHERE id=?', k + 1, id)));
  }
  res.redirect(`/teach/lessons/${lesson.id}#q-${q.id}`);
});

r.post('/questions/:id/delete', (req, res) => {
  const { question: q, lesson } = ownQuestion(req, req.params.id);
  const inUse = one('SELECT COUNT(*) AS n FROM enrollments WHERE current_question_id=?', q.id).n;
  if (inUse) {
    req.flash('error', 'A student is answering this question on WhatsApp right now. Try again in a moment.');
    return res.redirect(`/teach/lessons/${lesson.id}#q-${q.id}`);
  }
  removeUpload(q.explanation_file);
  run('DELETE FROM questions WHERE id=?', q.id);
  req.flash('success', 'Question deleted.');
  res.redirect(`/teach/lessons/${lesson.id}#questions`);
});

export default r;
