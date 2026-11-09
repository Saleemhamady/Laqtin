// Creates demo accounts and a sample course so the platform can be explored right away.
//   npm run seed
import { openDb, one, run } from '../src/db.js';
import { hashPassword } from '../src/lib.js';

openDb();

function user(name, email, role, phone) {
  const existing = one('SELECT * FROM users WHERE email=?', email);
  if (existing) return existing;
  const { lastInsertRowid } = run('INSERT INTO users (name, email, password_hash, role, phone) VALUES (?,?,?,?,?)', name, email, hashPassword('password123'), role, phone);
  return one('SELECT * FROM users WHERE id=?', lastInsertRowid);
}

user('Academy Admin', 'admin@laqtine.test', 'admin', null);
const teacher = user('Layla Haddad', 'teacher@laqtine.test', 'teacher', '+971500000001');
user('Omar Saeed', 'student@laqtine.test', 'student', '+971500000002');

if (!one('SELECT id FROM courses WHERE title=?', 'Python Basics')) {
  const { lastInsertRowid: courseId } = run(
    'INSERT INTO courses (teacher_id, title, summary, description, color, published) VALUES (?,?,?,?,?,1)',
    teacher.id,
    'Python Basics',
    'Write your first real programs in six bite-sized lessons.',
    'A friendly introduction to programming with Python. Each lesson is a short video followed by two or three practice questions on WhatsApp.\n\nNo experience needed — just curiosity and 10 minutes a day.',
    '#0d7a5f'
  );
  const lessons = [
    ['Variables and values', 'How Python stores information, and how to name things well.', 'https://www.youtube.com/watch?v=cQT33yu9pY8', [
      ['Which line creates a variable called age?', ['age == 30', 'age = 30', 'var age = 30', 'int age: 30'], 1, 'A single = assigns a value. == compares two values.'],
      ['What is the type of 3.5 in Python?', ['int', 'str', 'float', 'decimal'], 2, 'Numbers with a decimal point are floats.'],
    ]],
    ['Making decisions with if', 'Run different code depending on a condition.', 'https://www.youtube.com/watch?v=Zp5MuPOtsSY', [
      ['What does this print?  x = 5; if x > 3: print("big")', ['Nothing', 'big', 'x', 'An error'], 1, '5 > 3 is True, so the indented line runs.'],
      ['Which keyword handles "otherwise"?', ['elif', 'else', 'then', 'otherwise'], 1, 'else runs when no earlier condition matched.'],
    ]],
    ['Loops', 'Repeat work without repeating yourself.', 'https://www.youtube.com/watch?v=94UHCEmprCY', [
      ['How many times does  for i in range(3)  run?', ['2', '3', '4', 'Forever'], 1, 'range(3) gives 0, 1 and 2 — three values.'],
    ]],
  ];
  lessons.forEach(([title, description, url, qs], i) => {
    const { lastInsertRowid: lessonId } = run('INSERT INTO lessons (course_id, position, title, description, video_url) VALUES (?,?,?,?,?)', courseId, i + 1, title, description, url);
    qs.forEach(([prompt, options, correct, explanation], j) =>
      run('INSERT INTO questions (lesson_id, position, prompt, options, correct_index, explanation) VALUES (?,?,?,?,?,?)', lessonId, j + 1, prompt, JSON.stringify(options), correct, explanation)
    );
    if (i === 0) run('INSERT INTO materials (lesson_id, title, url) VALUES (?,?,?)', lessonId, 'Python cheat sheet', 'https://www.pythoncheatsheet.org/');
  });
}

console.log(`Seeded. Sign in with (password: password123):
  admin@laqtine.test    – admin
  teacher@laqtine.test  – teacher
  student@laqtine.test  – student`);
