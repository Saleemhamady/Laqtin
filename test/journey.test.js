import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, engine, makeUser, makeCourse, enroll, messages, lastPoll, vote, enrollmentRow } from './helpers.js';

const teacher = makeUser('teacher');

test('full WhatsApp journey: video → watched → polls → feedback → next lesson → done', async () => {
  const course = makeCourse(teacher.id);
  const student = makeUser();
  const eid = enroll(student.id, course.id);

  await engine.startJourney(eid);
  await engine.idle();
  let e = enrollmentRow(eid);
  assert.equal(e.wa_chat_id, `sim:${student.phone}`);
  assert.equal(e.wa_state, 'awaiting_watch');
  assert.equal(e.current_lesson_id, course.lessons[0].id);
  assert.match(messages(eid)[0].body.text, /Welcome/);
  assert.equal(lastPoll(eid).ref, `watch:${course.lessons[0].id}`);

  await vote(eid, 0); // "I watched it"
  e = enrollmentRow(eid);
  assert.equal(e.wa_state, 'quizzing');
  assert.equal(lastPoll(eid).ref, `question:${course.lessons[0].questions[0]}`);
  assert.deepEqual(lastPoll(eid).body.options, ['A. 3', 'B. 4', 'C. 5']);

  await vote(eid, 1); // correct
  const texts = messages(eid).filter((m) => m.kind === 'text').map((m) => m.body.text);
  assert.ok(texts.some((t) => t.includes('Correct') && t.includes('Basic addition')));
  assert.equal(lastPoll(eid).ref, `question:${course.lessons[0].questions[1]}`);

  await vote(eid, 1); // wrong (Rome)
  const after = messages(eid).filter((m) => m.kind === 'text').map((m) => m.body.text);
  assert.ok(after.some((t) => t.includes('Not quite') && t.includes('A. Paris')));
  assert.ok(after.some((t) => t.includes('1/2')), 'lesson score is reported');
  e = enrollmentRow(eid);
  assert.equal(e.current_lesson_id, course.lessons[1].id);
  assert.equal(e.wa_state, 'awaiting_watch');

  await vote(eid, 0); // watched lesson 2
  await vote(eid, 0); // correct
  e = enrollmentRow(eid);
  assert.equal(e.wa_state, 'done');
  assert.ok(e.completed_at);
  assert.match(messages(eid).at(-1).body.text, /Congratulations/);
  assert.deepEqual(engine.scoreFor(eid), { total: 3, correct: 2, pct: 67 });
});

test('portal actions advance the WhatsApp conversation', async () => {
  const course = makeCourse(teacher.id);
  const eid = enroll(makeUser().id, course.id);
  await engine.startJourney(eid);
  await engine.idle();

  engine.watched(eid, course.lessons[0].id, 'web');
  await engine.idle();
  assert.equal(enrollmentRow(eid).wa_state, 'quizzing');
  assert.ok(messages(eid).some((m) => m.body.text?.includes('finished the lesson on the portal')));

  const { answer } = engine.answer(eid, course.lessons[0].questions[0], 1, 'web');
  assert.equal(answer.is_correct, 1);
  await engine.idle();
  assert.equal(lastPoll(eid).ref, `question:${course.lessons[0].questions[1]}`, 'WhatsApp moved to the next question');
});

test('the first answer counts, wherever it came from', async () => {
  const course = makeCourse(teacher.id);
  const eid = enroll(makeUser().id, course.id);
  await engine.startJourney(eid);
  await engine.idle();
  await vote(eid, 0);
  const qPoll = lastPoll(eid);
  engine.answer(eid, course.lessons[0].questions[0], 0, 'web'); // wrong, on the web
  await engine.idle();
  await engine.handleInbound({ type: 'vote', pollId: qPoll.external_id, optionIndex: 1 }); // late WhatsApp vote
  await engine.idle();
  const a = db.one('SELECT * FROM answers WHERE enrollment_id=? AND question_id=?', eid, course.lessons[0].questions[0]);
  assert.equal(a.selected_index, 0);
  assert.equal(a.via, 'web');
  assert.ok(messages(eid).some((m) => m.body.text?.includes('first answer')));
});

test('lessons already watched on the portal skip the "I watched it" poll', async () => {
  const course = makeCourse(teacher.id);
  const eid = enroll(makeUser().id, course.id);
  engine.recordWatch(eid, course.lessons[0].id, 'web');
  await engine.startJourney(eid);
  await engine.idle();
  assert.equal(enrollmentRow(eid).wa_state, 'quizzing');
  assert.ok(!messages(eid).some((m) => m.ref?.startsWith('watch:')));
});

test('STOP pauses delivery and START resumes from the same place', async () => {
  const course = makeCourse(teacher.id);
  const eid = enroll(makeUser().id, course.id);
  await engine.startJourney(eid);
  await engine.idle();
  const chatId = enrollmentRow(eid).wa_chat_id;

  await engine.handleInbound({ type: 'text', chatId, text: 'stop' });
  await engine.idle();
  assert.equal(enrollmentRow(eid).wa_state, 'stopped');
  const count = messages(eid).length;

  engine.watched(eid, course.lessons[0].id, 'web'); // progress still recorded, nothing sent
  await engine.idle();
  assert.equal(messages(eid).length, count);
  assert.ok(db.one('SELECT watched_at FROM lesson_progress WHERE enrollment_id=?', eid).watched_at);

  await engine.handleInbound({ type: 'text', chatId, text: 'START' });
  await engine.idle();
  assert.equal(enrollmentRow(eid).wa_state, 'quizzing', 'resumes straight into the quiz since the video was watched');
});

test('students without a phone number get a clear error', async () => {
  const course = makeCourse(teacher.id);
  const eid = enroll(makeUser('student', { phone: null }).id, course.id);
  await engine.startJourney(eid);
  await engine.idle();
  const e = enrollmentRow(eid);
  assert.equal(e.wa_state, 'error');
  assert.match(e.wa_error, /WhatsApp number/);
});

test('reminders nudge quiet students, at most MAX_REMINDERS times', async () => {
  const course = makeCourse(teacher.id);
  const eid = enroll(makeUser().id, course.id);
  await engine.startJourney(eid);
  await engine.idle();
  const age = () => db.run(`UPDATE wa_messages SET created_at=datetime('now','-2 days') WHERE enrollment_id=?`, eid);
  age();
  assert.ok((await engine.sendReminders()) >= 1);
  await engine.idle();
  assert.match(messages(eid).at(-1).body.text, /waiting for you/);
  for (let i = 0; i < 5; i++) {
    age();
    await engine.sendReminders();
    await engine.idle();
  }
  assert.equal(enrollmentRow(eid).nudge_count, 3);
  assert.equal(messages(eid).filter((m) => m.body.text?.startsWith('⏰')).length, 3);
});
