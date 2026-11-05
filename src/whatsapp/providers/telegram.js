// Telegram provider (official Bot API).
//
//  • One private chat between the academy bot and each student. Bots can't open
//    chats, so the student taps a deep link (t.me/<bot>?start=<token>) once; that
//    also securely links their Telegram to their Laqtin account.
//  • Questions are native *quiz* polls: Telegram itself shows right/wrong and the
//    teacher's explanation (first 200 characters) the moment the student taps.
//  • "I watched it" is an inline button.
//  • Updates arrive by long polling, so no public webhook or HTTPS is required.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

const strip = (s) => String(s ?? '');
/** Our messages use WhatsApp-style *bold*; Telegram gets the HTML equivalent. */
export function toHtml(text) {
  return strip(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}
const plain = (text) => strip(text).replace(/\*([^*\n]+)\*/g, '$1');

export function createTelegramProvider({ token = config.telegram.token, fetchImpl = fetch } = {}) {
  const api = `https://api.telegram.org/bot${token}`;
  const state = { state: token ? 'connecting' : 'unconfigured', detail: token ? 'Connecting to Telegram…' : 'Set TELEGRAM_BOT_TOKEN (from @BotFather).', username: null };
  let onEvent = () => {};
  let running = false;
  let offset = 0;

  async function call(method, body, { multipart = false } = {}) {
    const res = await fetchImpl(`${api}/${method}`, multipart ? { method: 'POST', body } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const err = new Error(`Telegram: ${data.description || res.statusText}`);
      err.code = data.error_code;
      throw err;
    }
    return data.result;
  }

  function handleUpdate(u) {
    if (u.message?.text) {
      const m = u.message;
      const chatId = String(m.chat.id);
      if (m.chat.type !== 'private') return;
      const start = m.text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/);
      if (start) return onEvent({ type: 'start', chatId, payload: start[1] || '', username: m.from?.username || null });
      return onEvent({ type: 'text', chatId, text: m.text });
    }
    if (u.callback_query) {
      const q = u.callback_query;
      call('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
      const m = q.message;
      const idx = /^opt:(\d+)$/.exec(q.data || '');
      if (!m || !idx) return;
      // Remove the button so it can't be tapped twice.
      call('editMessageReplyMarkup', { chat_id: m.chat.id, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return onEvent({ type: 'vote', chatId: String(m.chat.id), pollId: `btn:${m.chat.id}:${m.message_id}`, optionIndex: Number(idx[1]) });
    }
    if (u.poll_answer) {
      const a = u.poll_answer;
      if (!a.option_ids?.length) return; // vote retracted
      return onEvent({ type: 'vote', chatId: String(a.user?.id ?? ''), pollId: String(a.poll_id), optionIndex: a.option_ids[0] });
    }
    if (u.my_chat_member && ['kicked', 'left'].includes(u.my_chat_member.new_chat_member?.status)) {
      return onEvent({ type: 'left', chatId: String(u.my_chat_member.chat.id) });
    }
  }

  async function loop() {
    while (running) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query', 'poll_answer', 'my_chat_member'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            await handleUpdate(u);
          } catch (err) {
            console.error('[telegram] update failed', err);
          }
        }
        if (state.state !== 'ready') Object.assign(state, { state: 'ready', detail: `Connected as @${state.username}` });
      } catch (err) {
        Object.assign(state, { state: 'connecting', detail: `${err.message} — retrying…` });
        if (err.code === 401) {
          Object.assign(state, { state: 'disconnected', detail: 'The bot token was rejected. Check TELEGRAM_BOT_TOKEN.' });
          running = false;
          return;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  const chatOf = (chatId) => (/^-?\d+$/.test(chatId) ? Number(chatId) : chatId);

  return {
    name: 'telegram',
    channel: 'telegram',
    label: 'Telegram bot (official Bot API)',
    interactiveMirror: false,
    nativeQuiz: true,
    needsPhone: false,
    maxVideoMb: config.telegram.maxVideoMb,
    sendDelayMs: 400,
    status: () => ({ ...state }),
    linkUrl: (linkToken) => (state.username ? `https://t.me/${state.username}?start=${linkToken}` : null),

    async start(handler) {
      onEvent = handler;
      if (!token) return;
      try {
        const me = await call('getMe');
        Object.assign(state, { state: 'ready', username: me.username, detail: `Connected as @${me.username}` });
        // Long polling and webhooks are mutually exclusive.
        await call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
        await call('setMyCommands', {
          commands: [
            { command: 'start', description: 'Connect / resume your lessons' },
            { command: 'stop', description: 'Pause lesson messages' },
          ],
        }).catch(() => {});
      } catch (err) {
        Object.assign(state, { state: 'disconnected', detail: err.message });
        return;
      }
      running = true;
      loop();
    },
    stop() {
      running = false;
    },
    /** Exposed for tests. */
    handleUpdate,

    async createChat({ user }) {
      if (user?.telegram_chat_id) return { chatId: String(user.telegram_chat_id) };
      return { chatId: null, pendingJoin: true };
    },

    async sendText(chatId, text) {
      const r = await call('sendMessage', { chat_id: chatOf(chatId), text: toHtml(text), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
      return { id: `msg:${chatId}:${r.message_id}` };
    },

    async sendVideo(chatId, { filePath, url, caption }) {
      const cap = toHtml(caption).slice(0, 1024);
      let r;
      if (filePath && fs.existsSync(filePath)) {
        const fd = new FormData();
        fd.append('chat_id', String(chatId));
        fd.append('caption', cap);
        fd.append('parse_mode', 'HTML');
        fd.append('supports_streaming', 'true');
        fd.append('video', await fs.openAsBlob(filePath), path.basename(filePath));
        r = await call('sendVideo', fd, { multipart: true });
      } else {
        r = await call('sendVideo', { chat_id: chatOf(chatId), video: url, caption: cap, parse_mode: 'HTML', supports_streaming: true });
      }
      return { id: `msg:${chatId}:${r.message_id}` };
    },

    async sendPoll(chatId, { name, options, correctIndex, explanation }) {
      if (options.length < 2) {
        // Single choice ("I watched it"): an inline button reads better than a poll.
        const r = await call('sendMessage', {
          chat_id: chatOf(chatId),
          text: toHtml(name),
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [options.map((o, i) => ({ text: plain(o).slice(0, 64), callback_data: `opt:${i}` }))] },
        });
        return { id: `btn:${chatId}:${r.message_id}` };
      }
      const body = {
        chat_id: chatOf(chatId),
        question: plain(name).slice(0, 300),
        options: options.map((o) => ({ text: plain(o).slice(0, 100) })),
        is_anonymous: false,
      };
      if (Number.isInteger(correctIndex)) {
        body.type = 'quiz';
        body.correct_option_id = correctIndex;
        if (explanation) {
          // Telegram allows 200 characters and at most 2 line breaks here.
          let ex = explanation.split('\n').slice(0, 3).join('\n');
          if (ex.length > 200) ex = ex.slice(0, 197) + '…';
          body.explanation = ex;
        }
      }
      const r = await call('sendPoll', body);
      return { id: String(r.poll.id) };
    },
  };
}
