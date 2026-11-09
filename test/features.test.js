import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, engine, makeUser, makeCourse, enroll, messages } from './helpers.js';

const { normalizePhone } = await import('../src/lib.js');
const { makeLink, readLink } = await import('../src/links.js');
const { config } = await import('../src/config.js');
const stream = await import('../src/stream.js');
const { createApp } = await import('../src/app.js');

let server, base;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  config.baseUrl = base; // so personal links point at this test server
});
after(() => server.close());

function browser() {
  const jar = new Map();
  let csrf = '';
  async function req(path, { method = 'GET', form, json } = {}) {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams({ _csrf: csrf, ...form }).toString();
    }
    if (json) {
      headers['content-type'] = 'application/json';
      headers['x-csrf-token'] = csrf;
      body = JSON.stringify(json);
    }
    const res = await fetch(path.startsWith('http') ? path : base + path, { method, headers, body, redirect: 'manual' });
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
  return { req };
}

async function signIn(b, email) {
  await b.req('/login');
  return b.req('/login', { method: 'POST', form: { email, password: 'password123' } });
}

// ---------- phone numbers ----------

test('Lebanese numbers can be typed without the country code', () => {
  assert.equal(normalizePhone('03 123 456'), '+9613123456');
  assert.equal(normalizePhone('70 123 456'), '+96170123456');
  assert.equal(normalizePhone('71-123-456'), '+96171123456');
  assert.equal(normalizePhone('00961 70 123 456'), '+96170123456');
  assert.equal(normalizePhone('96170123456'), '+96170123456');
  assert.equal(normalizePhone('+971 50 123 4567'), '+971501234567', 'other countries still work');
  assert.equal(normalizePhone('hello'), null);
  assert.equal(normalizePhone('123'), null);
});

// ---------- personal links ----------

test('personal links are signed and expire', () => {
  const token = makeLink(12, 34).split('/l/')[1];
  assert.deepEqual(readLink(token), { enrollmentId: 12, lessonId: 34 });
  assert.equal(readLink(token.replace(/^12\./, '13.')), null, 'tampered id is rejected');
  assert.equal(readLink('nonsense'), null);
  const old = makeLink(12, 34, Date.now() - 61 * 86400 * 1000).split('/l/')[1];
  assert.equal(readLink(old).expired, true);
});

test('lesson messages carry personal links that open the lesson without signing in', async () => {
  const teacher = makeUser('teacher');
  const course = makeCourse(teacher.id);
  const student = makeUser('student', { email: 'linky@test.dev' });
  const eid = enroll(student.id, course.id);
  await engine.startJourney(eid);
  await engine.idle();
  const lessonMsg = messages(eid).find((m) => m.body.text?.includes('Watch it here'));
  const url = lessonMsg.body.text.match(/https?:\/\/\S+\/l\/\S+/)[0];

  const b = browser();
  const r = await b.req(url);
  assert.equal(r.status, 302);
  assert.equal(r.location, `/learn/lesson/${course.lessons[0].id}`);
  assert.equal((await b.req(r.location)).status, 200, 'signed in as the student');

  // ...but a link session can't change account settings.
  await b.req('/profile');
  const p = await b.req('/profile', { method: 'POST', form: { name: 'Hacker', phone: '' } });
  assert.equal(p.location, '/login');
  assert.notEqual(db.one('SELECT name FROM users WHERE id=?', student.id).name, 'Hacker');
  const del = await b.req('/profile/delete', { method: 'POST', form: {} });
  assert.equal(del.location, '/login');
  assert.ok(db.one('SELECT id FROM users WHERE id=?', student.id), 'account not deleted');

  // A normal sign-in afterwards lifts the restriction.
  await signIn(b, 'linky@test.dev');
  await b.req('/profile');
  const ok = await b.req('/profile', { method: 'POST', form: { name: 'Linky', phone: '70 123 456' } });
  assert.equal(ok.location, '/profile');
  assert.equal(db.one('SELECT phone FROM users WHERE id=?', student.id).phone, '+96170123456');
});

test('links for teacher accounts or expired links require a real sign-in', async () => {
  const teacher = makeUser('teacher');
  const course = makeCourse(teacher.id);
  const eid = enroll(teacher.id, course.id);
  const r = await browser().req(makeLink(eid, course.lessons[0].id));
  assert.equal(r.location, '/login');

  const student = makeUser('student');
  const eid2 = enroll(student.id, course.id);
  const r2 = await browser().req(makeLink(eid2, 0, Date.now() - 90 * 86400 * 1000));
  assert.equal(r2.location, '/login');
  const r3 = await browser().req('/l/1.2.3.notavalidsignaturexxxxxxxxxx');
  assert.equal(r3.status, 400);
});

// ---------- video position ----------

test('the player saves where the student stopped and resumes there', async () => {
  const teacher = makeUser('teacher');
  const course = makeCourse(teacher.id);
  makeUser('student', { email: 'resume@test.dev' });
  const b = browser();
  await signIn(b, 'resume@test.dev');
  await b.req(`/courses/${course.id}`);
  await b.req(`/courses/${course.id}/enroll`, { method: 'POST', form: {} });
  await engine.idle();
  const lessonId = course.lessons[0].id;
  db.run(`UPDATE lessons SET video_url='https://example.com/v.mp4' WHERE id=?`, lessonId);
  await b.req(`/learn/lesson/${lessonId}`);
  assert.equal((await b.req(`/api/lessons/${lessonId}/position`, { method: 'POST', json: { seconds: 151.4 } })).status, 200);
  const page = await b.req(`/learn/lesson/${lessonId}`);
  assert.match(page.text, /data-resume="151"/);
});

// ---------- Cloudflare Stream ----------

test('Cloudflare Stream: direct upload → processing → adaptive playback', async () => {
  const calls = [];
  let ready = false;
  stream.setStreamFetch(async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization });
    let result;
    if (url.endsWith('/stream/direct_upload')) result = { uid: 'vid123', uploadURL: 'https://upload.videodelivery.net/abc' };
    else if (url.endsWith('/stream/vid123') && (init.method || 'GET') === 'GET')
      result = ready
        ? { uid: 'vid123', readyToStream: true, status: { state: 'ready' }, playback: { hls: 'https://customer-x.cloudflarestream.com/vid123/manifest/video.m3u8' }, thumbnail: 'https://customer-x.cloudflarestream.com/vid123/thumbnails/thumbnail.jpg', duration: 312 }
        : { uid: 'vid123', readyToStream: false, status: { state: 'inprogress', pctComplete: '42' } };
    else if (url.includes('/captions')) result = [];
    else result = {};
    return { ok: true, statusText: 'OK', json: async () => ({ success: true, result }) };
  });
  Object.assign(config.cloudflare, { accountId: 'acc1', apiToken: 'tok' });
  try {
    makeUser('teacher', { email: 'streamer@test.dev' });
    const b = browser();
    await signIn(b, 'streamer@test.dev');
    await b.req('/teach/courses/new');
    let r = await b.req('/teach/courses', { method: 'POST', form: { title: 'Video course' } });
    const courseId = Number(r.location.split('/').pop());
    await b.req(`/teach/courses/${courseId}`);
    r = await b.req(`/teach/courses/${courseId}/lessons`, { method: 'POST', form: { title: 'Intro' } });
    const lessonId = Number(r.location.split('/').pop());

    let page = await b.req(`/teach/lessons/${lessonId}`);
    assert.match(page.text, /data-stream-upload="\d+"/, 'teacher sees the direct-to-Cloudflare uploader');

    const up = await b.req(`/teach/lessons/${lessonId}/stream/upload`, { method: 'POST', json: {} });
    assert.equal(up.json().uploadURL, 'https://upload.videodelivery.net/abc');
    assert.equal(calls[0].auth, 'Bearer tok');
    assert.equal(db.one('SELECT stream_state FROM lessons WHERE id=?', lessonId).stream_state, 'uploading');

    let s = await b.req(`/teach/lessons/${lessonId}/stream/refresh`, { method: 'POST', json: {} });
    assert.deepEqual([s.json().state, s.json().pct], ['processing', 42]);

    ready = true;
    s = await b.req(`/teach/lessons/${lessonId}/stream/refresh`, { method: 'POST', json: {} });
    assert.equal(s.json().state, 'ready');
    const lesson = db.one('SELECT * FROM lessons WHERE id=?', lessonId);
    assert.match(lesson.stream_hls, /manifest\/video\.m3u8$/);
    assert.equal(lesson.stream_duration, 312);

    page = await b.req(`/teach/lessons/${lessonId}`);
    assert.match(page.text, /data-hls="https:\/\/customer-x\.cloudflarestream\.com\/vid123\/manifest\/video\.m3u8"/);
    assert.match(page.text, /\/static\/vendor\/hls\.min\.js/);
    assert.match(page.text, /Subtitles/);
    assert.equal((await fetch(`${base}/static/vendor/hls.min.js`)).status, 200);

    // Removing the video also deletes it from Cloudflare.
    r = await b.req(`/teach/lessons/${lessonId}`, { method: 'POST', form: { title: 'Intro', remove_video: '1' } });
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/stream/vid123')));
    assert.equal(db.one('SELECT stream_uid FROM lessons WHERE id=?', lessonId).stream_uid, null);
  } finally {
    Object.assign(config.cloudflare, { accountId: '', apiToken: '' });
    stream.setStreamFetch((...a) => fetch(...a));
  }
});
