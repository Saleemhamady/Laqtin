// Official WhatsApp Business Cloud API provider (Meta).
//
// Differences from the linked-number provider, imposed by the official API:
//  • Conversations are 1:1 with the academy number (no groups).
//  • Native polls are not available, so questions are sent as interactive
//    reply buttons (≤3 short options) or a list message (≤10 options).
//  • A business can only message first with an approved template. Set
//    WA_CLOUD_WELCOME_TEMPLATE; the journey starts once the student replies.
import crypto from 'node:crypto';
import express from 'express';
import { config } from '../../config.js';

const LETTERS = 'ABCDEFGHIJKL';

export function createCloudProvider() {
  const c = config.whatsapp.cloud;
  const configured = Boolean(c.token && c.phoneNumberId);
  let onEvent = () => {};

  async function send(payload) {
    const res = await fetch(`https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp Cloud API: ${data?.error?.message || res.statusText}`);
    return { id: data.messages?.[0]?.id };
  }

  const strip = (s) => s.replace(/^[A-L]\.\s*/, '');

  function webhookRouter() {
    const r = express.Router();
    r.get('/', (req, res) => {
      if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === c.verifyToken) return res.send(req.query['hub.challenge']);
      res.sendStatus(403);
    });
    r.post('/', express.raw({ type: '*/*' }), (req, res) => {
      const secret = process.env.WA_CLOUD_APP_SECRET;
      if (secret) {
        const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
        const got = req.get('x-hub-signature-256') || '';
        if (got.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return res.sendStatus(401);
      }
      res.sendStatus(200);
      let body;
      try {
        body = JSON.parse(req.body.toString('utf8'));
      } catch {
        return;
      }
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          for (const m of change.value?.messages || []) {
            const chatId = m.from;
            onEvent({ type: 'joined', chatId });
            const reply = m.interactive?.button_reply || m.interactive?.list_reply;
            if (reply?.id?.startsWith('opt:') && m.context?.id) {
              onEvent({ type: 'vote', chatId, pollId: m.context.id, optionIndex: Number(reply.id.slice(4)) });
            } else if (m.text?.body) {
              onEvent({ type: 'text', chatId, text: m.text.body });
            }
          }
        }
      }
    });
    return r;
  }

  return {
    name: 'cloud',
    label: 'WhatsApp Business Cloud API (official, 1:1 chats)',
    interactiveMirror: false,
    webhookRouter,
    async start(handler) {
      onEvent = handler;
    },
    status: () =>
      configured
        ? { state: 'ready', detail: `Phone number ID ${c.phoneNumberId}. Webhook: ${config.baseUrl}/webhooks/whatsapp` }
        : { state: 'unconfigured', detail: 'Set WA_CLOUD_TOKEN and WA_CLOUD_PHONE_NUMBER_ID.' },

    async createChat({ phone, name }) {
      if (!configured) throw new Error('WhatsApp Cloud API is not configured');
      const to = String(phone).replace(/\D/g, '');
      if (!c.welcomeTemplate) return { chatId: to };
      await send({
        to,
        type: 'template',
        template: {
          name: c.welcomeTemplate,
          language: { code: c.templateLang },
          components: [{ type: 'body', parameters: [{ type: 'text', text: name.split(' ')[0] }] }],
        },
      });
      return { chatId: to, pendingJoin: true };
    },

    sendText: (to, text) => send({ to, type: 'text', text: { body: text, preview_url: true } }),

    sendVideo: (to, { url, caption }) => send({ to, type: 'video', video: { link: url, caption } }),

    async sendPoll(to, { name, options }) {
      const plain = options.map(strip);
      if (plain.length <= 3 && plain.every((o) => o.length <= 20)) {
        return send({
          to,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: name.slice(0, 1024) },
            action: { buttons: plain.map((o, i) => ({ type: 'reply', reply: { id: `opt:${i}`, title: o } })) },
          },
        });
      }
      const listed = options.map((o) => `${o}`).join('\n');
      return send({
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: `${name}\n\n${listed}`.slice(0, 1024) },
          action: {
            button: 'Choose answer',
            sections: [{ title: 'Options', rows: plain.slice(0, 10).map((o, i) => ({ id: `opt:${i}`, title: LETTERS[i], description: o.slice(0, 72) })) }],
          },
        },
      });
    },
  };
}
