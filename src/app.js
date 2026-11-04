import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import cookieSession from 'cookie-session';
import { config } from './config.js';
import { one } from './db.js';
import { getProvider } from './whatsapp/engine.js';
import { initials, WA_STATE_LABEL, WA_STATE_TONE } from './lib.js';
import { icon } from './icons.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import studentRoutes from './routes/student.js';
import teacherRoutes from './routes/teacher.js';
import adminRoutes from './routes/admin.js';

export function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.root, 'src/views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          mediaSrc: ["'self'", 'https:'],
          frameSrc: ["'self'", 'https://www.youtube-nocookie.com', 'https://www.youtube.com', 'https://player.vimeo.com'],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.baseUrl.startsWith('https://') ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );

  fs.mkdirSync(config.uploadDir, { recursive: true });
  app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: '1h' }));
  app.use(
    '/uploads',
    express.static(config.uploadDir, {
      setHeaders: (res, filePath) => {
        res.set('X-Content-Type-Options', 'nosniff');
        // Teacher-uploaded HTML runs in a sandbox with an opaque origin: it can be
        // interactive, but can never act as the portal or read students' sessions.
        if (/\.html?$/i.test(filePath)) {
          res.set('Content-Security-Policy', "sandbox allow-scripts allow-popups allow-forms allow-modals; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'");
        }
      },
    })
  );

  // Provider webhooks (WhatsApp Cloud API) must be mounted before body parsers.
  const provider = getProvider();
  if (provider?.webhookRouter) app.use('/webhooks/whatsapp', provider.webhookRouter());

  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(
    cookieSession({
      name: 'laqtin',
      keys: [config.sessionSecret],
      maxAge: 30 * 24 * 3600 * 1000,
      sameSite: 'lax',
      httpOnly: true,
      secure: config.baseUrl.startsWith('https://'),
    })
  );

  // Current user, flash messages, CSRF token
  app.use((req, res, next) => {
    req.user = req.session.uid ? one('SELECT id, name, email, role, phone, avatar_url, onboarded FROM users WHERE id=?', req.session.uid) : null;
    if (req.session.uid && !req.user) req.session = null;
    if (req.session && !req.session.csrf) req.session.csrf = crypto.randomBytes(18).toString('base64url');
    res.locals.user = req.user;
    res.locals.csrf = req.session?.csrf;
    res.locals.flash = req.session?.flash || null;
    if (req.session?.flash) delete req.session.flash;
    res.locals.path = req.path;
    res.locals.initials = initials;
    res.locals.icon = icon;
    res.locals.WA_STATE_LABEL = WA_STATE_LABEL;
    res.locals.WA_STATE_TONE = WA_STATE_TONE;
    res.locals.waProvider = getProvider();
    res.locals.baseUrl = config.baseUrl;
    req.flash = (type, text) => (req.session.flash = { type, text });
    next();
  });

  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const token = req.body?._csrf || req.get('x-csrf-token') || req.query._csrf;
    if (!token || token !== req.session?.csrf) return res.status(403).render('error', { title: 'Session expired', message: 'Please go back, refresh the page and try again.' });
    next();
  });

  app.use(authRoutes);
  app.use(publicRoutes);
  app.use(studentRoutes);
  app.use('/teach', teacherRoutes);
  app.use('/admin', adminRoutes);

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: "We couldn't find that page." }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    const message = err.code === 'LIMIT_FILE_SIZE' ? `That file is too big (max ${config.maxUploadMb} MB).` : err.expose ? err.message : 'Something went wrong.';
    if (req.accepts(['html', 'json']) === 'json') return res.status(status).json({ error: message });
    res.status(status).render('error', { title: 'Oops', message });
  });
  return app;
}
