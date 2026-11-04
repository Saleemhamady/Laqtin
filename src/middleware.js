import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { config } from './config.js';

export function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return requireUser(req, res, next);
  if (roles.includes(req.user.role)) return next();
  res.status(403).render('error', { title: 'Not allowed', message: "Your account doesn't have access to this page." });
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogg']);
const MATERIAL_EXT = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.zip', '.mp3', '.m4a', '.mp4', '.webm', '.mov', '.html', '.htm']);
const EXPLANATION_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.mp3', '.m4a']);

export const fileKind = (name = '') => {
  const ext = path.extname(name).toLowerCase();
  if (['.mp4', '.webm', '.mov', '.m4v', '.ogg'].includes(ext)) return 'video';
  if (['.html', '.htm'].includes(ext)) return 'html';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  if (['.mp3', '.m4a'].includes(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  return 'file';
};

function uploader(allowed) {
  return multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, cb) => cb(null, `${crypto.randomBytes(12).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (allowed.has(ext)) return cb(null, true);
      cb(new HttpError(400, `Files of type ${ext || 'unknown'} are not allowed here.`));
    },
  });
}

export const videoUpload = uploader(VIDEO_EXT);
export const materialUpload = uploader(MATERIAL_EXT);
export const explanationUpload = uploader(EXPLANATION_EXT);
