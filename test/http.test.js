import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, engine, makeUser, makeCourse } from './helpers.js';

const { createApp } = await import('../src/app.js');
let server, base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

/** Minimal browser: keeps cookies and the CSRF token. */
function browser() {
  const jar = new Map();
  let csrf = '';
  async function req(path, { method = 'GET', form, json, body, headers = {} } = {}) {
    const h = { ...headers, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    let payload = body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams({ _csrf: csrf, ...form }).toString();
    }
    if (json) {
      h['content-type'] = 'application/json';
      h['x-csrf-token'] = csrf;
      payload = JSON.stringify(json);
    }
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, ...v] = kv.split('=');
      jar.set(k.trim(), v.join('='));
    }
    const text = await res.text();
    const m = text.match(/name="csrf-token" content="([^"]+)"/);
    if (m) csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, json: () => JSON.parse(text) };
  }
  return { req, get csrf() { return csrf; } };
}

async function signIn(b, email) {
  await b.req('/login');
  const r = await b.req('/login', { method: 'POST', form: { email, password: 'password123' } });
  assert.equal(r.status, 302, 'login redirects');
  return r;
}

test('public pages render', async () => {
  const b = browser();
  for (const p of ['/', '/courses', '/login', '/signup', '/privacy', '/terms', '/healthz']) {
    assert.equal((await b.req(p)).status, 200, p);
  }
  assert.equal((await b.req('/nope')).status, 404);
});

test('security headers are set', async () => {
  const res = await fetch(base + '/');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('signup validates and requires a WhatsApp number for students', async () => {
  const b = browser();
  await b.req('/signup');
  let r = await b.req('/signup', { method: 'POST', form: { name: 'Ann', email: 'ann@x.dev', password: 'password123', role: 'student' } });
  assert.equal(r.status, 400);
  assert.match(r.text, /WhatsApp number is needed/);
  r = await b.req('/signup', { method: 'POST', form: { name: 'Ann', email: 'ann@x.dev', password: 'password123', role: 'student', phone: '+971 50 111 2222' } });
  assert.equal(r.status, 302);
  assert.equal(db.one('SELECT phone FROM users WHERE email=?', 'ann@x.dev').phone, '+971501112222');
});

test('POST without a CSRF token is rejected', async () => {
  const b = browser();
  await b.req('/login');
  const r = await b.req('/login', { method: 'POST', body: 'email=a&password=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(r.status, 403);
});

test('wrong password is rejected', async () => {
  makeUser('student', { email: 'pw@test.dev' });
  const b = browser();
  await b.req('/login');
  const r = await b.req('/login', { method: 'POST', form: { email: 'pw@test.dev', password: 'nope-nope' } });
  assert.equal(r.status, 401);
});

test('students cannot reach teacher or admin pages', async () => {
  makeUser('student', { email: 'nosy@test.dev' });
  const b = browser();
  await signIn(b, 'nosy@test.dev');
  assert.equal((await b.req('/teach')).status, 403);
  assert.equal((await b.req('/admin')).status, 403);
});

test('enroll, watch and answer through the portal API', async () => {
  const teacher = makeUser('teacher');
  const course = makeCourse(teacher.id);
  const student = makeUser('student', { email: 'learner@test.dev' });
  const b = browser();
  await signIn(b, 'learner@test.dev');

  // Not enrolled yet → lesson is locked
  assert.equal((await b.req(`/learn/lesson/${course.lessons[0].id}`)).status, 403);

  await b.req(`/courses/${course.id}`);
  const r = await b.req(`/courses/${course.id}/enroll`, { method: 'POST', form: {} });
  assert.equal(r.location, `/learn/course/${course.id}`);
  await engine.idle();
  const e = db.one('SELECT * FROM enrollments WHERE user_id=?', student.id);
  assert.equal(e.wa_state, 'awaiting_watch');

  assert.equal((await b.req(`/learn/lesson/${course.lessons[0].id}`)).status, 200);
  assert.equal((await b.req(`/api/lessons/${course.lessons[0].id}/watched`, { method: 'POST', json: {} })).status, 200);
  const ans = await b.req(`/api/questions/${course.lessons[0].questions[0]}/answer`, { method: 'POST', json: { index: 1 } });
  assert.deepEqual({ correct: ans.json().correct, correctIndex: ans.json().correctIndex }, { correct: true, correctIndex: 1 });

  const msgs = await b.req(`/api/enrollments/${e.id}/messages`);
  assert.ok(msgs.json().messages.length > 3);

  // Another student can't read this conversation
  makeUser('student', { email: 'other@test.dev' });
  const other = browser();
  await signIn(other, 'other@test.dev');
  assert.equal((await other.req(`/api/enrollments/${e.id}/messages`)).status, 404);
});

test('teachers author lessons and questions with explanation files', async () => {
  const teacher = makeUser('teacher', { email: 'author@test.dev' });
  const b = browser();
  await signIn(b, 'author@test.dev');
  await b.req('/teach/courses/new');
  let r = await b.req('/teach/courses', { method: 'POST', form: { title: 'Chemistry', summary: 'Atoms', color: '#0f766e' } });
  const courseId = Number(r.location.split('/').pop());
  await b.req(`/teach/courses/${courseId}`);
  r = await b.req(`/teach/courses/${courseId}/lessons`, { method: 'POST', form: { title: 'Atoms 101' } });
  const lessonId = Number(r.location.split('/').pop());
  await b.req(`/teach/lessons/${lessonId}`);

  const fd = new FormData();
  fd.append('prompt', 'Smallest unit of an element?');
  ['Atom', '', 'Molecule', 'Cell'].forEach((o) => fd.append('options', o));
  fd.append('correct', '0');
  fd.append('explanation', 'Atoms are the building blocks.');
  fd.append('explanation_file', new Blob(['<h1>Atoms</h1>'], { type: 'text/html' }), 'atoms.html');
  r = await b.req(`/teach/lessons/${lessonId}/questions?_csrf=${encodeURIComponent(b.csrf)}`, { method: 'POST', body: fd });
  assert.equal(r.status, 302);
  const q = db.one('SELECT * FROM questions WHERE lesson_id=?', lessonId);
  assert.deepEqual(JSON.parse(q.options), ['Atom', 'Molecule', 'Cell'], 'empty options are dropped');
  assert.equal(q.correct_index, 0);
  assert.match(q.explanation_file, /\.html$/);

  // Uploaded HTML is served sandboxed
  const res = await fetch(`${base}/uploads/${q.explanation_file}`);
  assert.match(res.headers.get('content-security-policy'), /sandbox/);

  // Disallowed file types are refused
  const bad = new FormData();
  bad.append('prompt', 'x');
  bad.append('options', 'a');
  bad.append('options', 'b');
  bad.append('correct', '0');
  bad.append('explanation_file', new Blob(['MZ']), 'virus.exe');
  r = await b.req(`/teach/lessons/${lessonId}/questions?_csrf=${encodeURIComponent(b.csrf)}`, { method: 'POST', body: bad });
  assert.equal(r.status, 400);

  // Publishing requires at least one lesson; this course has one
  r = await b.req(`/teach/courses/${courseId}/publish`, { method: 'POST', form: { publish: '1' } });
  assert.equal(db.one('SELECT published FROM courses WHERE id=?', courseId).published, 1);

  // Another teacher can't edit it
  makeUser('teacher', { email: 'rival@test.dev' });
  const rival = browser();
  await signIn(rival, 'rival@test.dev');
  assert.equal((await rival.req(`/teach/lessons/${lessonId}`)).status, 404);
  assert.ok(teacher.id);
});

test('students can choose Telegram at enrollment (no phone needed)', async () => {
  const { createMockProvider } = await import('../src/whatsapp/providers/mock.js');
  engine.setProvider(createMockProvider({ channel: 'telegram' }), 'telegram');
  const teacher = makeUser('teacher');
  const course = makeCourse(teacher.id);
  const student = makeUser('student', { email: 'tg@test.dev', phone: null });
  const b = browser();
  await signIn(b, 'tg@test.dev');
  const page = await b.req(`/courses/${course.id}`);
  assert.match(page.text, /name="channel" value="telegram"/);
  const r = await b.req(`/courses/${course.id}/enroll`, { method: 'POST', form: { channel: 'telegram' } });
  assert.equal(r.location, `/learn/course/${course.id}`);
  await engine.idle();
  const e = db.one('SELECT * FROM enrollments WHERE user_id=?', student.id);
  assert.equal(e.channel, 'telegram');
  assert.equal(e.wa_state, 'awaiting_watch', 'simulator connects instantly');
  assert.equal((await b.req(`/learn/course/${course.id}`)).status, 200);
});

test('users can delete their account', async () => {
  const u = makeUser('student', { email: 'leaver@test.dev' });
  const b = browser();
  await signIn(b, 'leaver@test.dev');
  await b.req('/profile');
  const r = await b.req('/profile/delete', { method: 'POST', form: {} });
  assert.equal(r.status, 302);
  assert.equal(db.one('SELECT id FROM users WHERE id=?', u.id), undefined);
});
