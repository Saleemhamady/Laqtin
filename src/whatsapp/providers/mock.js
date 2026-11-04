// Simulator provider: nothing leaves the server. The portal shows the conversation
// as a WhatsApp-style chat where polls can be tapped, so the whole journey can be
// tried end to end without a phone.
import { randomUUID } from 'node:crypto';

export function createMockProvider() {
  const id = () => `mock-${randomUUID()}`;
  return {
    name: 'mock',
    label: 'Simulator',
    interactiveMirror: true,
    async start() {},
    status: () => ({ state: 'ready', detail: 'Simulator mode — messages appear in the portal only. Set WHATSAPP_PROVIDER=baileys or cloud to go live.' }),
    async createChat({ phone }) {
      return { chatId: `sim:${phone}` };
    },
    async sendText() {
      return { id: id() };
    },
    async sendVideo() {
      return { id: id() };
    },
    async sendPoll() {
      return { id: id() };
    },
  };
}
