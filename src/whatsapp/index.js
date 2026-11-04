import { config } from '../config.js';
import { setProvider, handleInbound } from './engine.js';
import { createMockProvider } from './providers/mock.js';

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
  setProvider(provider);
  await provider.start((evt) =>
    handleInbound(evt).catch((err) => console.error('[whatsapp] inbound event failed', evt, err))
  );
  console.log(`[whatsapp] provider: ${provider.name}`);
  return provider;
}
