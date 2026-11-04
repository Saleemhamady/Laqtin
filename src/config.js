import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  port: Number(process.env.PORT || 3000),
  // Public URL of the portal, used in links sent over WhatsApp.
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  env: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-me',
  // When false, new accounts are always students; admins promote teachers.
  allowTeacherSignup: (process.env.ALLOW_TEACHER_SIGNUP ?? 'true') === 'true',
  oauth: {
    google: { clientId: process.env.GOOGLE_CLIENT_ID || '', clientSecret: process.env.GOOGLE_CLIENT_SECRET || '' },
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID || '',
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
      tenant: process.env.MICROSOFT_TENANT || 'common',
    },
    facebook: { clientId: process.env.FACEBOOK_APP_ID || '', clientSecret: process.env.FACEBOOK_APP_SECRET || '' },
  },
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  uploadDir: process.env.UPLOAD_DIR || path.join(root, 'uploads'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 500),
  whatsapp: {
    // mock | baileys | cloud
    provider: process.env.WHATSAPP_PROVIDER || 'mock',
    // Videos up to this size are attached in WhatsApp; bigger ones are sent as a portal link.
    maxVideoMb: Number(process.env.WHATSAPP_MAX_VIDEO_MB || 16),
    cloud: {
      token: process.env.WA_CLOUD_TOKEN || '',
      phoneNumberId: process.env.WA_CLOUD_PHONE_NUMBER_ID || '',
      verifyToken: process.env.WA_CLOUD_VERIFY_TOKEN || '',
      apiVersion: process.env.WA_CLOUD_API_VERSION || 'v21.0',
      // Approved template used for the first, business-initiated message.
      welcomeTemplate: process.env.WA_CLOUD_WELCOME_TEMPLATE || '',
      templateLang: process.env.WA_CLOUD_TEMPLATE_LANG || 'en',
    },
  },
};

if (config.env === 'production') {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters in production.');
  }
  if (!process.env.BASE_URL) throw new Error('BASE_URL must be set in production (e.g. https://academy.example.com).');
}
