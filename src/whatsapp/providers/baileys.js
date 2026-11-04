// WhatsApp Web provider (Baileys). This is the one that matches the Laqtin concept
// exactly: a dedicated number opens a *group* per student+course and sends native
// WhatsApp *polls*. It links to the number like WhatsApp Web does (scan a QR code
// from the admin page).
//
// ⚠️ Baileys is an unofficial client. WhatsApp may restrict numbers that automate
// heavily; use a dedicated number and keep volumes reasonable.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { one, run } from '../../db.js';
import { config } from '../../config.js';

const kvGet = (k) => {
  const r = one('SELECT v FROM kv WHERE k=?', k);
  return r ? JSON.parse(r.v) : null;
};
const kvSet = (k, v) => run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, JSON.stringify(v));

export async function createBaileysProvider() {
  let B;
  try {
    B = await import('baileys');
  } catch {
    throw new Error('The "baileys" package is not installed. Run: npm install baileys');
  }
  const makeWASocket = B.default;
  const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, decryptPollVote, jidNormalizedUser } = B;
  const authDir = path.join(config.dataDir, 'whatsapp-auth');

  let sock = null;
  let onEvent = () => {};
  const state = { state: 'connecting', qr: null, me: null, detail: '' };
  const quietLogger = { level: 'silent', child: () => quietLogger, trace() {}, debug() {}, info() {}, warn() {}, error: (...a) => console.error('[baileys]', ...a), fatal: (...a) => console.error('[baileys]', ...a) };

  const toJid = (phone) => `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`;
  const ready = () => {
    if (!sock || state.state !== 'ready') throw new Error('WhatsApp number is not connected (open Admin → WhatsApp to link it)');
    return sock;
  };

  async function connect() {
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      /* use bundled version */
    }
    sock = makeWASocket({ auth, version, logger: quietLogger, browser: ['Laqtin', 'Chrome', '1.0'], markOnlineOnConnect: false });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
      if (qr) Object.assign(state, { state: 'qr', qr, detail: 'Scan the QR code with the academy phone: WhatsApp → Linked devices → Link a device.' });
      if (connection === 'open') Object.assign(state, { state: 'ready', qr: null, me: sock.user, detail: `Connected as ${sock.user?.id?.split(':')[0]}` });
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(authDir, { recursive: true, force: true });
          Object.assign(state, { state: 'disconnected', qr: null, detail: 'Logged out from the phone. Reconnecting to show a new QR code…' });
        } else {
          Object.assign(state, { state: 'connecting', detail: `Connection closed (${code ?? 'unknown'}), reconnecting…` });
        }
        setTimeout(() => connect().catch((e) => console.error('[baileys] reconnect failed', e)), 2000);
      }
    });

    sock.ev.on('group-participants.update', ({ id, action }) => {
      if (action === 'add') onEvent({ type: 'joined', chatId: id });
      if (action === 'remove' || action === 'leave') onEvent({ type: 'left', chatId: id });
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const chatId = m.key.remoteJid;
        const pu = m.message.pollUpdateMessage;
        if (pu) {
          const vote = decodeVote(m, pu);
          if (vote) onEvent({ type: 'vote', chatId, ...vote });
          continue;
        }
        const text = m.message.conversation || m.message.extendedTextMessage?.text;
        if (text) onEvent({ type: 'text', chatId, text });
      }
    });
  }

  // WhatsApp poll votes are end-to-end encrypted with the poll's secret. We keep the
  // secret + options of every poll we send so we can decrypt the vote here.
  function decodeVote(m, pu) {
    const pollId = pu.pollCreationMessageKey?.id;
    const saved = pollId && kvGet(`baileys:poll:${pollId}`);
    if (!saved) return null;
    const secret = Buffer.from(saved.secret, 'base64');
    const norm = (j) => (j ? jidNormalizedUser(j) : null);
    const creators = [...new Set([norm(sock.user?.id), norm(sock.user?.lid)].filter(Boolean))];
    const voters = [...new Set([m.key.participant, m.key.participantAlt, m.key.remoteJidAlt, m.key.remoteJid].map(norm).filter((j) => j && !j.endsWith('@g.us')))];
    for (const pollCreatorJid of creators) {
      for (const voterJid of voters) {
        try {
          const decoded = decryptPollVote(pu.vote, { pollCreatorJid, pollMsgId: pollId, pollEncKey: secret, voterJid });
          const hashes = (decoded.selectedOptions || []).map((b) => Buffer.from(b).toString('hex'));
          if (!hashes.length) return null; // vote withdrawn
          const optionIndex = saved.options.findIndex((o) => createHash('sha256').update(Buffer.from(o)).digest('hex') === hashes[0]);
          return optionIndex >= 0 ? { pollId, optionIndex } : null;
        } catch {
          /* wrong jid combination, try the next */
        }
      }
    }
    console.warn('[baileys] could not decrypt poll vote for', pollId);
    return null;
  }

  return {
    name: 'baileys',
    label: 'WhatsApp (linked number, groups + polls)',
    interactiveMirror: false,
    async start(handler) {
      onEvent = handler;
      await connect();
    },
    status: () => ({ ...state }),

    async createChat({ phone, title }) {
      const s = ready();
      const jid = toJid(phone);
      const [exists] = await s.onWhatsApp(jid);
      if (!exists?.exists) throw new Error(`${phone} is not on WhatsApp`);
      const group = await s.groupCreate(title, [exists.jid || jid]);
      const meta = await s.groupMetadata(group.id);
      if ((meta.participants || []).length >= 2) return { chatId: group.id };
      // The student's privacy settings blocked the add: DM them an invite link and
      // wait for them to join before starting (new members can't see older messages).
      const code = await s.groupInviteCode(group.id);
      const inviteLink = `https://chat.whatsapp.com/${code}`;
      await s.sendMessage(exists.jid || jid, { text: `👋 You're enrolled in *${title}* on Laqtin! Join your learning group to get your first lesson: ${inviteLink}` });
      return { chatId: group.id, inviteLink, pendingJoin: true };
    },

    async sendText(chatId, text) {
      const r = await ready().sendMessage(chatId, { text });
      return { id: r?.key?.id };
    },

    async sendVideo(chatId, { filePath, caption }) {
      const r = await ready().sendMessage(chatId, { video: { url: filePath }, caption, mimetype: 'video/mp4' });
      return { id: r?.key?.id };
    },

    async sendPoll(chatId, { name, options }) {
      const secret = randomBytes(32);
      const r = await ready().sendMessage(chatId, { poll: { name, values: options, selectableCount: 1, messageSecret: secret } });
      const id = r?.key?.id;
      kvSet(`baileys:poll:${id}`, { secret: secret.toString('base64'), options, chatId });
      return { id };
    },
  };
}
