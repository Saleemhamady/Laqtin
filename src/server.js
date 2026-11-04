import { config } from './config.js';
import { openDb, getDb } from './db.js';
import { initWhatsApp } from './whatsapp/index.js';
import { recoverInterrupted, sendReminders } from './whatsapp/engine.js';
import { createApp } from './app.js';

openDb();
await initWhatsApp();
const server = createApp().listen(config.port, () => {
  console.log(`Laqtin is running on ${config.baseUrl} (${config.env})`);
});

recoverInterrupted();
const remindTimer = setInterval(() => {
  sendReminders().catch((err) => console.error('[reminders]', err));
}, 15 * 60 * 1000);

function shutdown(signal) {
  console.log(`${signal} received, shutting down…`);
  clearInterval(remindTimer);
  server.close(() => {
    try {
      getDb().close();
    } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
