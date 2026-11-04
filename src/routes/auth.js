import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { one, all, run } from '../db.js';
import { hashPassword, verifyPassword, normalizePhone } from '../lib.js';
import { enabledProviders, isEnabled, authorizationUrl, handleCallback } from '../oauth.js';
import { requireUser } from '../middleware.js';

const r = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.env === 'test',
  handler: (req, res) => res.status(429).render('error', { title: 'Too many attempts', message: 'Please wait a few minutes and try again.' }),
});

const firstUserRole = () => (one('SELECT COUNT(*) AS n FROM users').n === 0 ? 'admin' : null);

function signIn(req, user) {
  req.session.uid = user.id;
  req.session.csrf = null; // rotate
}

function afterLogin(req, res, user) {
  if (!user.onboarded) return res.redirect('/welcome');
  const to = req.session.returnTo;
  delete req.session.returnTo;
  if (to && to.startsWith('/') && !to.startsWith('//')) return res.redirect(to);
  res.redirect(user.role === 'student' ? '/learn' : '/teach');
}

// Anyone half-way through social sign-up finishes onboarding first.
r.use((req, res, next) => {
  if (req.user && !req.user.onboarded && !['/welcome', '/logout'].includes(req.path)) {
    return res.redirect('/welcome');
  }
  const nextUrl = String(req.query.next || '');
  if (req.method === 'GET' && nextUrl.startsWith('/') && !nextUrl.startsWith('//')) req.session.returnTo = nextUrl;
  res.locals.socialProviders = enabledProviders();
  res.locals.allowTeacherSignup = config.allowTeacherSignup;
  next();
});

r.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'Sign in', values: {} });
});

r.post('/login', authLimiter, (req, res) => {
  const email = String(req.body.email || '').trim();
  const user = one('SELECT * FROM users WHERE email=?', email);
  if (!user || !user.password_hash || !verifyPassword(String(req.body.password || ''), user.password_hash)) {
    return res.status(401).render('auth/login', { title: 'Sign in', values: { email }, error: 'That email and password don’t match.' });
  }
  signIn(req, user);
  afterLogin(req, res, user);
});

r.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/signup', { title: 'Create account', values: { role: req.query.role === 'teacher' ? 'teacher' : 'student' } });
});

r.post('/signup', authLimiter, (req, res) => {
  const values = {
    name: String(req.body.name || '').trim(),
    email: String(req.body.email || '').trim().toLowerCase(),
    phone: String(req.body.phone || '').trim(),
    role: req.body.role === 'teacher' && config.allowTeacherSignup ? 'teacher' : 'student',
  };
  const password = String(req.body.password || '');
  const phone = values.phone ? normalizePhone(values.phone) : null;
  let error;
  if (!values.name) error = 'Please enter your name.';
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email)) error = 'Please enter a valid email address.';
  else if (password.length < 8) error = 'Your password needs at least 8 characters.';
  else if (values.phone && !phone) error = 'Enter your WhatsApp number with the country code, e.g. +971 50 123 4567.';
  else if (values.role === 'student' && !phone) error = 'Your WhatsApp number is needed so we can send you lessons.';
  else if (one('SELECT id FROM users WHERE email=?', values.email)) error = 'An account with this email already exists. Try signing in.';
  if (error) return res.status(400).render('auth/signup', { title: 'Create account', values, error });

  const role = firstUserRole() || values.role;
  const { lastInsertRowid } = run(
    'INSERT INTO users (name, email, password_hash, role, phone) VALUES (?,?,?,?,?)',
    values.name, values.email, hashPassword(password), role, phone
  );
  const user = one('SELECT * FROM users WHERE id=?', lastInsertRowid);
  signIn(req, user);
  afterLogin(req, res, user);
});

r.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// ---------- social sign-in ----------

r.get('/auth/:provider', authLimiter, (req, res) => {
  if (!isEnabled(req.params.provider)) return res.redirect('/login');
  res.redirect(authorizationUrl(req.params.provider, req.session));
});

r.get('/auth/:provider/callback', async (req, res, next) => {
  const name = req.params.provider;
  if (!isEnabled(name)) return res.redirect('/login');
  let profile;
  try {
    profile = await handleCallback(name, req.query, req.session);
  } catch (err) {
    req.flash('error', err.message);
    return res.redirect(req.user ? '/profile' : '/login');
  }
  try {
    const identity = one('SELECT * FROM user_identities WHERE provider=? AND subject=?', name, profile.subject);
    const label = name[0].toUpperCase() + name.slice(1);

    if (identity) {
      if (req.user && req.user.id !== identity.user_id) {
        req.flash('error', `That ${label} account is already connected to another Laqtin account.`);
        return res.redirect('/profile');
      }
      const user = one('SELECT * FROM users WHERE id=?', identity.user_id);
      signIn(req, user);
      return afterLogin(req, res, user);
    }

    if (req.user) {
      run('INSERT INTO user_identities (provider, subject, user_id, email) VALUES (?,?,?,?)', name, profile.subject, req.user.id, profile.email);
      req.flash('success', `${label} is now connected. You can use it to sign in.`);
      return res.redirect('/profile');
    }

    let user = profile.email ? one('SELECT * FROM users WHERE email=?', profile.email) : null;
    if (user && !profile.emailVerified) {
      req.flash('error', `An account with ${profile.email} already exists. Sign in with your password, then connect ${label} from your profile.`);
      return res.redirect('/login');
    }
    if (!user) {
      const email = profile.email || `${name}-${profile.subject}@users.noreply.laqtin`;
      const { lastInsertRowid } = run(
        'INSERT INTO users (name, email, role, avatar_url, onboarded) VALUES (?,?,?,?,0)',
        profile.name || email.split('@')[0], email, firstUserRole() || 'student', profile.avatar
      );
      user = one('SELECT * FROM users WHERE id=?', lastInsertRowid);
    }
    run('INSERT INTO user_identities (provider, subject, user_id, email) VALUES (?,?,?,?)', name, profile.subject, user.id, profile.email);
    if (!user.avatar_url && profile.avatar) run('UPDATE users SET avatar_url=? WHERE id=?', profile.avatar, user.id);
    signIn(req, user);
    afterLogin(req, res, user);
  } catch (err) {
    next(err);
  }
});

// ---------- onboarding (after social sign-up) ----------

r.get('/welcome', requireUser, (req, res) => {
  const u = one('SELECT * FROM users WHERE id=?', req.user.id);
  if (u.onboarded) return res.redirect('/');
  res.render('auth/welcome', { title: 'Welcome', values: { name: u.name, role: u.role === 'admin' ? 'teacher' : 'student', phone: u.phone || '' }, isAdmin: u.role === 'admin' });
});

r.post('/welcome', requireUser, (req, res) => {
  const u = one('SELECT * FROM users WHERE id=?', req.user.id);
  const values = {
    name: String(req.body.name || '').trim(),
    phone: String(req.body.phone || '').trim(),
    role: req.body.role === 'teacher' && config.allowTeacherSignup ? 'teacher' : 'student',
  };
  const phone = values.phone ? normalizePhone(values.phone) : null;
  let error;
  if (!values.name) error = 'Please enter your name.';
  else if (values.phone && !phone) error = 'Enter your WhatsApp number with the country code, e.g. +971 50 123 4567.';
  else if (values.role === 'student' && u.role !== 'admin' && !phone) error = 'Your WhatsApp number is needed so we can send you lessons.';
  if (error) return res.status(400).render('auth/welcome', { title: 'Welcome', values, error, isAdmin: u.role === 'admin' });
  const role = u.role === 'admin' ? 'admin' : values.role;
  run('UPDATE users SET name=?, phone=?, role=?, onboarded=1 WHERE id=?', values.name, phone, role, u.id);
  afterLogin(req, res, { ...u, role, onboarded: 1 });
});

// ---------- profile ----------

r.get('/profile', requireUser, (req, res) => {
  const identities = all('SELECT provider, email, created_at FROM user_identities WHERE user_id=?', req.user.id);
  const hasPassword = Boolean(one('SELECT password_hash FROM users WHERE id=?', req.user.id).password_hash);
  res.render('profile', { title: 'Profile', identities, hasPassword, values: req.user });
});

r.post('/profile', requireUser, (req, res) => {
  const name = String(req.body.name || '').trim();
  const rawPhone = String(req.body.phone || '').trim();
  const phone = rawPhone ? normalizePhone(rawPhone) : null;
  const identities = all('SELECT provider, email, created_at FROM user_identities WHERE user_id=?', req.user.id);
  const hasPassword = Boolean(one('SELECT password_hash FROM users WHERE id=?', req.user.id).password_hash);
  const fail = (error) => res.status(400).render('profile', { title: 'Profile', identities, hasPassword, values: { ...req.user, name, phone: rawPhone }, error });
  if (!name) return fail('Please enter your name.');
  if (rawPhone && !phone) return fail('Enter your WhatsApp number with the country code, e.g. +971 50 123 4567.');
  run('UPDATE users SET name=?, phone=? WHERE id=?', name, phone, req.user.id);
  const pw = String(req.body.new_password || '');
  if (pw) {
    if (pw.length < 8) return fail('Your new password needs at least 8 characters.');
    run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(pw), req.user.id);
  }
  req.flash('success', 'Profile saved.');
  res.redirect('/profile');
});

r.post('/profile/identities/:provider/remove', requireUser, (req, res) => {
  const u = one('SELECT password_hash FROM users WHERE id=?', req.user.id);
  const count = one('SELECT COUNT(*) AS n FROM user_identities WHERE user_id=?', req.user.id).n;
  if (!u.password_hash && count <= 1) {
    req.flash('error', 'Set a password first — otherwise you would have no way to sign in.');
  } else {
    run('DELETE FROM user_identities WHERE user_id=? AND provider=?', req.user.id, req.params.provider);
    req.flash('success', 'Disconnected.');
  }
  res.redirect('/profile');
});

export default r;
