import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,              -- null for social-only accounts
  role TEXT NOT NULL CHECK (role IN ('admin','teacher','student')),
  phone TEXT,
  avatar_url TEXT,
  onboarded INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Social logins (google, facebook, microsoft) linked to a user
CREATE TABLE IF NOT EXISTS user_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (provider, subject)
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#0f766e',
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  video_url TEXT,
  video_file TEXT,
  video_size INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file TEXT,
  url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,          -- JSON array of strings
  correct_index INTEGER NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  explanation_file TEXT,          -- optional uploaded video / HTML / image / PDF explaining the answer
  explanation_file_name TEXT,
  explanation_file_size INTEGER,
  explanation_url TEXT            -- or a link (YouTube, Vimeo, any page)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- WhatsApp journey state
  wa_chat_id TEXT,
  wa_invite_link TEXT,
  wa_state TEXT NOT NULL DEFAULT 'pending', -- pending|awaiting_watch|quizzing|done|error
  wa_error TEXT,
  current_lesson_id INTEGER,
  current_question_id INTEGER,
  completed_at TEXT,
  last_progress_at TEXT,
  nudge_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS lesson_progress (
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  watched_at TEXT,
  watched_via TEXT,
  quiz_completed_at TEXT,
  PRIMARY KEY (enrollment_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  selected_index INTEGER NOT NULL,
  is_correct INTEGER NOT NULL,
  via TEXT NOT NULL,              -- web | whatsapp
  answered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (enrollment_id, question_id)
);

-- Every message exchanged with the student on WhatsApp, mirrored in the portal.
CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY,
  enrollment_id INTEGER NOT NULL REFERENCES enrollments(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,        -- out | in
  kind TEXT NOT NULL,             -- text | video | poll | vote
  body TEXT NOT NULL,             -- JSON
  ref TEXT,                       -- 'watch:<lessonId>' or 'question:<questionId>' for polls
  external_id TEXT,               -- provider message id
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS wa_messages_ext ON wa_messages(external_id);
CREATE INDEX IF NOT EXISTS wa_messages_enr ON wa_messages(enrollment_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

-- Key/value store (provider credentials, etc.)
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

let db;

export function openDb(file = path.join(config.dataDir, 'laqtin.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive migrations for databases created by earlier versions.
function migrate(d) {
  const add = (table, column, def) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  };
  add('enrollments', 'last_progress_at', 'TEXT');
  add('enrollments', 'nudge_count', 'INTEGER NOT NULL DEFAULT 0');
  add('questions', 'explanation_file', 'TEXT');
  add('questions', 'explanation_file_name', 'TEXT');
  add('questions', 'explanation_file_size', 'INTEGER');
  add('questions', 'explanation_url', 'TEXT');
  add('users', 'avatar_url', 'TEXT');
  add('users', 'onboarded', 'INTEGER NOT NULL DEFAULT 1');
}

export function getDb() {
  if (!db) openDb();
  return db;
}

export const one = (sql, ...p) => getDb().prepare(sql).get(...p);
export const all = (sql, ...p) => getDb().prepare(sql).all(...p);
export const run = (sql, ...p) => getDb().prepare(sql).run(...p);

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function parseQuestion(q) {
  return q ? { ...q, options: JSON.parse(q.options) } : q;
}
