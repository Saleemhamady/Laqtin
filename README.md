# Laqtine

An academy where courses are short videos plus practice, delivered through **WhatsApp** or **Telegram** (each student chooses when enrolling):

1. A student enrolls on the web portal with their WhatsApp number.
2. The academy number opens a **WhatsApp group** with the student and sends lesson 1.
3. The student taps **"✅ I watched it"** (or finishes the video on the portal).
4. Each practice question arrives as a **WhatsApp poll**. The student votes and gets feedback right away, including the teacher's explanation (text, video, HTML page, image or PDF).
5. They get a score, then the next lesson, and so on until they finish the course.

Everything is synced with the portal. Students can watch and answer on either side, and the conversation is mirrored live. Teachers see each student's progress and answers.

## Features

- **Students:** browse and enroll, lesson player that tracks watching, practice with instant feedback, a live WhatsApp chat mirror, a way to pause or resume WhatsApp, and a progress dashboard.
- **Teachers:** courses, lessons (upload a video or paste a YouTube, Vimeo or MP4 link), materials (files or links, including HTML), and a question builder with a live WhatsApp poll preview and explanations (text, uploaded video/HTML/image/PDF, or a link). Per-student progress, answers, the WhatsApp conversation, and a one-click retry.
- **Admins:** WhatsApp connection (scan a QR code), academy stats, students who need attention, and user roles.
- **Sign-in:** email and password, or **Google, Microsoft and Facebook**. Accounts are linked safely, and onboarding asks for a role and WhatsApp number. Password reset works by email.
- **WhatsApp:** reminders when a student goes quiet, the STOP/START keywords, pacing between messages, and resuming journeys after a restart.
- **Production:** Helmet security headers and CSP, CSRF protection, rate-limited auth, scrypt passwords, uploaded HTML served in a sandbox, SQLite in WAL mode, a health check, graceful shutdown, Docker, and tests.

## Quick start

```bash
npm install
npm run seed    # demo accounts + a sample course (password: password123)
npm run dev     # http://localhost:3000
```

Demo logins: `admin@laqtine.test`, `teacher@laqtine.test`, `student@laqtine.test`.

By default `WHATSAPP_PROVIDER=mock`. Nothing is sent, and the portal shows a **WhatsApp simulator** where you can tap the polls yourself. Enroll as the student and try it.

Run the tests with `npm test`.

## Going live

Copy `.env.example` to `.env` and fill it in. `BASE_URL` and a 32+ character `SESSION_SECRET` are required in production.

```bash
docker compose up -d --build
```

Put it behind HTTPS (Caddy, Nginx, a load balancer). Data lives in two volumes: `data/` (SQLite database and WhatsApp session) and `uploads/` (videos and files). Back both up. For the database, `sqlite3 data/laqtine.db ".backup backup.db"` is safe while the app is running.

Run **one instance**. A WhatsApp number can only have one live connection, and SQLite is a single-node database.

### WhatsApp: choose a provider

| | `baileys` (linked number) | `cloud` (official Meta API) |
|---|---|---|
| Group per student | ✅ | ❌ (1:1 chat) |
| Native polls | ✅ | Interactive buttons / list instead |
| Setup | Scan a QR code in **Admin → WhatsApp** | Meta Business account, approved template, webhook |
| Risk | Unofficial client. Use a dedicated number; WhatsApp can restrict numbers it sees as automated spam | Officially supported |

**`baileys`** gives you exactly the experience described above: groups and real polls. Set `WHATSAPP_PROVIDER=baileys`, start the app, open **Admin**, and scan the QR code from the academy phone (*WhatsApp → Linked devices*). If a student's privacy settings stop the number from adding them, they get an invite link by DM and lessons start once they join.

**`cloud`** uses the official API. Configure `WA_CLOUD_*` and point the webhook to `{BASE_URL}/webhooks/whatsapp` (subscribe to `messages`). Businesses must open a conversation with an approved template, so set `WA_CLOUD_WELCOME_TEMPLATE` to a template with one body parameter (the student's first name). The journey starts when the student replies.

### Video: Cloudflare Stream

Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (with **Account → Stream → Edit**), and subscribe to Stream in the Cloudflare dashboard. Then:

- Teachers' uploads go **straight from the browser to Cloudflare** (up to 200 MB per video), never through this server or Cloudflare's 100 MB proxy limit. The lesson page shows the upload progress, then "preparing", and switches to the player once Stream has processed the video.
- Students get **adaptive streaming** that starts at a low bitrate and is capped at `VIDEO_MAX_HEIGHT` (720p by default). A **Data saver** switch caps it at 360p.
- The player has **speed control** (0.75×–2×, remembered) and **resumes** where the student stopped, saved on the server so it works across devices.
- **Subtitles:** generate them automatically or upload a `.vtt` file (Arabic, English, French) from the lesson editor. They appear in the player's CC menu.
- Deleting or replacing a lesson video also deletes it from Stream.

Without Stream configured, videos are stored on the server as before, and YouTube, Vimeo or MP4 links still work.

### Personal lesson links

Every lesson and course link sent on WhatsApp or Telegram is personal: `/l/<enrollment>.<lesson>.<expiry>.<signature>`, signed with `SESSION_SECRET` and valid for 60 days. Tapping it opens the lesson **without signing in**. To stay safe if a link is forwarded:
- only student accounts are signed in this way, and expired links fall back to the sign-in page;
- a link session can't change the profile or password, delete the account, or attach a Google, Microsoft or Facebook login. Those need a normal sign-in.

Changing `SESSION_SECRET` invalidates all links (and sessions).

### Telegram

Telegram runs alongside WhatsApp. When it's enabled, students pick **WhatsApp** or **Telegram** when they enroll.

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token.
2. Set `TELEGRAM_BOT_TOKEN` and restart. **Admin** shows the bot as connected.

How it works:
- Bots can't message people first. After enrolling, the student taps **Connect Telegram**, which opens `t.me/<bot>?start=<one-time token>`, and presses **Start**. That links their Telegram to their Laqtine account; no phone number is needed. Later courses start right away.
- Questions are native Telegram **quiz polls**. Telegram shows right or wrong and the first 200 characters of the explanation inside the poll. Longer explanations, links and files follow as a message, and explanation videos are sent directly (up to 50 MB).
- "I watched it" is an inline button. `/stop` pauses and `/start` resumes.
- Updates arrive by long polling, so no public webhook is needed. Run one instance per bot token.

To try it without a bot, set `TELEGRAM_MODE=mock`. The portal then offers Telegram with a simulator.

### Social sign-in

Create an OAuth app with each provider and register these redirect URIs:

- Google (Google Cloud Console → Credentials → OAuth client ID, type *Web*): `{BASE_URL}/auth/google/callback`
- Microsoft (Entra ID → App registrations, *Accounts in any organizational directory and personal Microsoft accounts*): `{BASE_URL}/auth/microsoft/callback`
- Facebook (Meta for Developers → Facebook Login): `{BASE_URL}/auth/facebook/callback`

Only providers with credentials configured appear on the sign-in page. Providers need your privacy policy URL, which is `{BASE_URL}/privacy`. The privacy and terms pages are starting templates; review them before launch.

The **first account created becomes the admin**.

## Project layout

```
src/
  server.js              boot, reminders timer, graceful shutdown
  app.js                 express app, security, sessions, CSRF
  db.js                  SQLite schema + migrations
  oauth.js               Google / Microsoft / Facebook sign-in
  whatsapp/engine.js     the learning journey state machine (provider-independent)
  whatsapp/providers/    mock (simulator), baileys (groups + polls), cloud (official API), telegram (bot + quiz polls)
  routes/                public, auth, student, teacher, admin
  views/                 EJS templates
public/                  CSS, JS, favicon
test/                    node:test suites (journey, HTTP, Telegram)
```
