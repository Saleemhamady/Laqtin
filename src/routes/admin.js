import { Router } from 'express';
import QRCode from 'qrcode';
import { one, all, run } from '../db.js';
import { requireRole, HttpError } from '../middleware.js';
import * as engine from '../whatsapp/engine.js';

const r = Router();
r.use(requireRole('admin'));

r.get('/', async (req, res) => {
  const provider = engine.getProvider();
  const status = provider?.status() || { state: 'unconfigured', detail: 'No provider' };
  const qr = status.qr ? await QRCode.toDataURL(status.qr, { margin: 1, width: 280 }) : null;
  const stats = one(`SELECT
      (SELECT COUNT(*) FROM users WHERE role='student') AS students,
      (SELECT COUNT(*) FROM users WHERE role IN ('teacher','admin')) AS teachers,
      (SELECT COUNT(*) FROM courses WHERE published=1) AS courses,
      (SELECT COUNT(*) FROM enrollments) AS enrollments,
      (SELECT COUNT(*) FROM answers) AS answers,
      (SELECT COUNT(*) FROM wa_messages) AS messages`);
  const attention = all(
    `SELECT e.*, u.name, u.phone, c.title FROM enrollments e JOIN users u ON u.id=e.user_id JOIN courses c ON c.id=e.course_id
      WHERE e.wa_state = 'error' OR (e.wa_state = 'awaiting_join' AND e.created_at < datetime('now','-1 day')) ORDER BY e.id DESC LIMIT 50`
  );
  const tg = engine.getProvider('telegram');
  res.render('admin/index', { title: 'Admin', provider, status, qr, stats, attention, tg, tgStatus: tg?.status() || null });
});

r.get('/status.json', async (req, res) => {
  const s = engine.getProvider()?.status() || {};
  const qr = s.qr ? await QRCode.toDataURL(s.qr, { margin: 1, width: 280 }) : null;
  res.json({ state: s.state, detail: s.detail, qr });
});

r.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  const users = all(
    `SELECT u.*, (SELECT GROUP_CONCAT(provider, ', ') FROM user_identities i WHERE i.user_id=u.id) AS providers
       FROM users u ${q ? 'WHERE u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?' : ''} ORDER BY u.created_at DESC LIMIT 200`,
    ...(q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [])
  );
  res.render('admin/users', { title: 'Users', users, q });
});

r.post('/users/:id/role', (req, res) => {
  const role = req.body.role;
  if (!['student', 'teacher', 'admin'].includes(role)) throw new HttpError(400, 'Invalid role');
  const id = Number(req.params.id);
  if (id === req.user.id && role !== 'admin') {
    req.flash('error', 'You can’t remove your own admin access.');
  } else {
    run('UPDATE users SET role=? WHERE id=?', role, id);
    req.flash('success', 'Role updated.');
  }
  res.redirect('/admin/users');
});

r.post('/enrollments/:id/retry', (req, res) => {
  engine.retry(Number(req.params.id));
  req.flash('success', 'Retrying WhatsApp delivery.');
  res.redirect('/admin');
});

export default r;
