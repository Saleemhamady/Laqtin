import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, engine, makeUser, makeCourse, enroll, messages, enrollmentRow } from './helpers.js';

const { createTelegramProvider, toHtml } = await import('../src/whatsapp/providers/telegram.js');

/** Fake Telegram Bot API that records calls and returns plausible results. */
function fakeTelegram() {
  const calls = [];
  let msgId = 100;
  let pollId = 5000;
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const body = init.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(init.body || '{}');
    calls.push({ method, body });
    const result = {
      getMe: { id: 1, username: 'LaqtineBot' },
      sendPoll: { message_id: ++msgId, poll: { id: String(++pollId) } },
      getUpdates: [],
    }[method] ?? { message_id: ++msgId };
    return { ok: true, statusText: 'OK', json: async () => ({ ok: true, result }) };
  };
  return { calls, fetchImpl };
}

async function setup() {
  const fake = fakeTelegram();
  const tg = createTelegramProvider({ token: 'test-token', fetchImpl: fake.fetchImpl });
  engine.setProvider(tg, 'telegram');
  // Feed provider events into the engine like src/whatsapp/index.js does.
  await tg.start((evt) => engine.handleInbound({ ...evt, channel: 'telegram' }));
  tg.stop(); // no long-polling loop in tests; we push updates by hand
  return { tg, fake };
}

let updateId = 1;
const tgUpdate = (tg, u) => Promise.resolve(tg.handleUpdate({ update_id: updateId++, ...u })).then(() => engine.idle());

test('toHtml converts *bold* and escapes HTML', () => {
  assert.equal(toHtml('*Hi* <b> & you'), '<b>Hi</b> &lt;b&gt; &amp; you');
});

test('Telegram journey: connect link → lesson → button → quiz polls → done', async () => {
  const { tg, fake } = await setup();
  const teacher = makeUser('teacher');
  const course = makeCourse(teacher.id);
  const student = makeUser('student', { phone: null });
  db.run(`UPDATE users SET telegram_link_token='tok123' WHERE id=?`, student.id);
  const eid = Number(db.run(`INSERT INTO enrollments (user_id, course_id, channel) VALUES (?,?, 'telegram')`, student.id, course.id).lastInsertRowid);

  // No phone needed; waits for the student to open the bot.
  await engine.startJourney(eid);
  await engine.idle();
  assert.equal(enrollmentRow(eid).wa_state, 'awaiting_join');
  assert.equal(tg.linkUrl('tok123'), 'https://t.me/LaqtineBot?start=tok123');

  // Student presses Start in Telegram via the deep link.
  await tgUpdate(tg, { message: { chat: { id: 777, type: 'private' }, from: { username: 'omar' }, text: '/start tok123' } });
  assert.equal(db.one('SELECT telegram_chat_id FROM users WHERE id=?', student.id).telegram_chat_id, '777');
  let e = enrollmentRow(eid);
  assert.equal(e.wa_chat_id, '777');
  assert.equal(e.wa_state, 'awaiting_watch');

  // "I watched it" is an inline button, not a poll.
  const button = fake.calls.filter((c) => c.method === 'sendMessage').find((c) => c.body.reply_markup);
  assert.equal(button.body.reply_markup.inline_keyboard[0][0].callback_data, 'opt:0');
  const btnMsg = messages(eid).find((m) => m.ref?.startsWith('watch:'));
  const [, chat, mid] = btnMsg.external_id.split(':');
  await tgUpdate(tg, { callback_query: { id: 'cb1', data: 'opt:0', message: { chat: { id: Number(chat) }, message_id: Number(mid) } } });
  assert.equal(enrollmentRow(eid).wa_state, 'quizzing');

  // Questions are native quiz polls with the correct answer and explanation.
  const quiz = fake.calls.filter((c) => c.method === 'sendPoll').at(-1).body;
  assert.equal(quiz.type, 'quiz');
  assert.equal(quiz.correct_option_id, 1);
  assert.equal(quiz.is_anonymous, false);
  assert.equal(quiz.explanation, 'Basic addition.');
  assert.deepEqual(quiz.options.map((o) => o.text), ['A. 3', 'B. 4', 'C. 5']);

  const textsBefore = fake.calls.filter((c) => c.method === 'sendMessage').length;
  const pollOf = () => messages(eid).filter((m) => m.kind === 'poll').at(-1).external_id;
  await tgUpdate(tg, { poll_answer: { poll_id: pollOf(), user: { id: 777 }, option_ids: [1] } });
  // Telegram already showed "correct" + explanation, so no duplicate feedback message.
  const newTexts = fake.calls.filter((c) => c.method === 'sendMessage').slice(textsBefore).map((c) => c.body.text);
  assert.ok(!newTexts.some((t) => /Correct!/.test(t)), 'no duplicate feedback');
  assert.equal(db.one('SELECT is_correct, via FROM answers WHERE enrollment_id=? AND question_id=?', eid, course.lessons[0].questions[0]).via, 'telegram');

  await tgUpdate(tg, { poll_answer: { poll_id: pollOf(), user: { id: 777 }, option_ids: [0] } }); // Q2 correct
  e = enrollmentRow(eid);
  assert.equal(e.current_lesson_id, course.lessons[1].id);

  // Lesson 2: watch + answer → course complete
  const btn2 = messages(eid).filter((m) => m.ref?.startsWith('watch:')).at(-1).external_id.split(':');
  await tgUpdate(tg, { callback_query: { id: 'cb2', data: 'opt:0', message: { chat: { id: Number(btn2[1]) }, message_id: Number(btn2[2]) } } });
  await tgUpdate(tg, { poll_answer: { poll_id: pollOf(), user: { id: 777 }, option_ids: [0] } });
  assert.equal(enrollmentRow(eid).wa_state, 'done');
  const last = fake.calls.filter((c) => c.method === 'sendMessage').at(-1).body;
  assert.match(last.text, /<b>Congratulations!<\/b>/);
  assert.equal(last.parse_mode, 'HTML');
});

test('Telegram /stop pauses and /start resumes every course in that chat', async () => {
  const { tg } = await setup();
  const teacher = makeUser('teacher');
  const student = makeUser('student', { phone: null });
  db.run(`UPDATE users SET telegram_chat_id='888' WHERE id=?`, student.id);
  const ids = [makeCourse(teacher.id), makeCourse(teacher.id)].map((c) =>
    Number(db.run(`INSERT INTO enrollments (user_id, course_id, channel) VALUES (?,?, 'telegram')`, student.id, c.id).lastInsertRowid)
  );
  for (const id of ids) await engine.startJourney(id);
  await engine.idle();
  assert.deepEqual(ids.map((id) => enrollmentRow(id).wa_state), ['awaiting_watch', 'awaiting_watch'], 'already-linked students start immediately');

  await tgUpdate(tg, { message: { chat: { id: 888, type: 'private' }, text: '/stop' } });
  assert.deepEqual(ids.map((id) => enrollmentRow(id).wa_state), ['stopped', 'stopped']);
  // /start without a token from a linked chat → treated as resume
  await tgUpdate(tg, { message: { chat: { id: 888, type: 'private' }, text: '/start' } });
  assert.deepEqual(ids.map((id) => enrollmentRow(id).wa_state), ['awaiting_watch', 'awaiting_watch']);
});

test('unknown /start gets instructions, not an error', async () => {
  const { tg, fake } = await setup();
  await tgUpdate(tg, { message: { chat: { id: 999, type: 'private' }, text: '/start nope' } });
  assert.match(fake.calls.at(-1).body.text, /Connect Telegram/);
});

test('a WhatsApp poll id never matches a Telegram vote', async () => {
  const teacher = makeUser('teacher');
  const course = makeCourse(teacher.id);
  const eid = enroll(makeUser().id, course.id); // whatsapp (mock)
  await engine.startJourney(eid);
  await engine.idle();
  const p = messages(eid).filter((m) => m.kind === 'poll').at(-1);
  await engine.handleInbound({ type: 'vote', channel: 'telegram', pollId: p.external_id, optionIndex: 0 });
  await engine.idle();
  assert.equal(enrollmentRow(eid).wa_state, 'awaiting_watch');
});
