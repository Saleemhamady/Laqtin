// Simulator provider: nothing leaves the server. The portal shows the conversation
// as a chat where polls can be tapped, so the whole journey can be tried end to end
// without a phone. With channel 'telegram' it behaves like the Telegram bot
// (native quiz polls, no phone needed, instant "connect").
import { randomUUID } from 'node:crypto';

export function createMockProvider({ channel = 'whatsapp' } = {}) {
  const id = () => `mock-${randomUUID()}`;
  const telegram = channel === 'telegram';
  return {
    name: 'mock',
    channel,
    label: telegram ? 'Telegram simulator' : 'Simulator',
    interactiveMirror: true,
    nativeQuiz: telegram,
    needsPhone: !telegram,
    async start() {},
    status: () => ({ state: 'ready', detail: 'Simulator mode — messages appear in the portal only.' }),
    linkUrl: () => null,
    async createChat({ phone, user }) {
      return { chatId: telegram ? `sim-tg:${user?.id}` : `sim:${phone}` };
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
