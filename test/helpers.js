import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laqtin-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = dir;
process.env.UPLOAD_DIR = path.join(dir, 'uploads');
process.env.BASE_URL = 'http://localhost:0';
process.env.WHATSAPP_SEND_DELAY_MS = '0';

const db = await import('../src/db.js');
db.openDb(':memory:');
const { createMockProvider } = await import('../src/whatsapp/providers/mock.js');
const engine = await import('../src/whatsapp/engine.js');
engine.setProvider(createMockProvider());
const { hashPassword } = await import('../src/lib.js');

export { db, engine };

let n = 0;
export function makeUser(role = 'student', extra = {}) {
  n++;
  const { lastInsertRowid } = db.run(
    'INSERT INTO users (name, email, password_hash, role, phone) VALUES (?,?,?,?,?)',
    extra.name || `User ${n}`, extra.email || `u${n}@test.dev`, hashPassword('password123'), role, 'phone' in extra ? extra.phone : `+97150000${String(n).padStart(4, '0')}`
  );
  return db.one('SELECT * FROM users WHERE id=?', lastInsertRowid);
}

/** A published course with two lessons: lesson 1 has 2 questions, lesson 2 has 1. */
export function makeCourse(teacherId) {
  const { lastInsertRowid: courseId } = db.run('INSERT INTO courses (teacher_id, title, published) VALUES (?,?,1)', teacherId, 'Test course');
  const lessons = [];
  [[['2+2?', ['3', '4', '5'], 1, 'Basic addition.'], ['Capital of France?', ['Paris', 'Rome'], 0, '']], [['Sky colour?', ['Blue', 'Green'], 0, 'Rayleigh scattering.']]].forEach((qs, i) => {
    const { lastInsertRowid: lessonId } = db.run('INSERT INTO lessons (course_id, position, title) VALUES (?,?,?)', courseId, i + 1, `Lesson ${i + 1}`);
    const questions = qs.map(([prompt, options, correct, explanation], j) =>
      Number(db.run('INSERT INTO questions (lesson_id, position, prompt, options, correct_index, explanation) VALUES (?,?,?,?,?,?)', lessonId, j + 1, prompt, JSON.stringify(options), correct, explanation).lastInsertRowid)
    );
    lessons.push({ id: Number(lessonId), questions });
  });
  return { id: Number(courseId), lessons };
}

export function enroll(userId, courseId) {
  return Number(db.run('INSERT INTO enrollments (user_id, course_id) VALUES (?,?)', userId, courseId).lastInsertRowid);
}

export const messages = (enrollmentId) =>
  db.all('SELECT * FROM wa_messages WHERE enrollment_id=? ORDER BY id', enrollmentId).map((m) => ({ ...m, body: JSON.parse(m.body) }));

export const lastPoll = (enrollmentId) => messages(enrollmentId).filter((m) => m.kind === 'poll').at(-1);

export async function vote(enrollmentId, optionIndex) {
  const p = lastPoll(enrollmentId);
  await engine.handleInbound({ type: 'vote', pollId: p.external_id, optionIndex });
  await engine.idle();
  return p;
}

export const enrollmentRow = (id) => db.one('SELECT * FROM enrollments WHERE id=?', id);
