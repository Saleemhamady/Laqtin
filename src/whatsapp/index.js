import { config } from '../config.js';
import { setProvider, handleInbound } from './engine.js';
import { createMockProvider } from './providers/mock.js';

const handlerFor = (channel) => (evt) =>
  handleInbound({ ...evt, channel }).catch((err) => console.error(`[${channel}] inbound event failed`, evt, err));

export async function initWhatsApp(name = config.whatsapp.provider) {
  let provider;
  if (name === 'baileys') {
    const { createBaileysProvider } = await import('./providers/baileys.js');
    provider = await createBaileysProvider();
  } else if (name === 'cloud') {
    const { createCloudProvider } = await import('./providers/cloud.js');
    provider = createCloudProvider();
  } else {
    provider = createMockProvider();
  }
  setProvider(provider, 'whatsapp');
  await provider.start(handlerFor('whatsapp'));
  console.log(`[whatsapp] provider: ${provider.name}`);

  // Telegram is optional and runs alongside WhatsApp; students choose per course.
  if (config.telegram.token) {
    const { createTelegramProvider } = await import('./providers/telegram.js');
    const tg = createTelegramProvider();
    setProvider(tg, 'telegram');
    await tg.start(handlerFor('telegram'));
    console.log(`[telegram] ${tg.status().detail}`);
  } else if (config.telegram.mode === 'mock') {
    setProvider(createMockProvider({ channel: 'telegram' }), 'telegram');
    console.log('[telegram] simulator');
  }
  return provider;
}
