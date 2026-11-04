import { config } from './config.js';
import { openDb } from './db.js';
import { initWhatsApp } from './whatsapp/index.js';
import { createApp } from './app.js';

openDb();
await initWhatsApp();
createApp().listen(config.port, () => {
  console.log(`Laqtin is running on ${config.baseUrl}`);
});
