'use strict';

const crypto = require('node:crypto');

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const newId = () => crypto.randomBytes(8).toString('hex');
const LEVELS = new Set(['info', 'important', 'urgent']);
const STATUSES = new Set(['scheduled', 'live', 'done', 'cancelled', 'changed']);
const TYPES = new Set(['competition', 'other']);
const CHECK_TAGS = new Set(['carry', 'cargo']);

function send(res, status, body) {
  res.status(status).setHeader('Cache-Control', 'no-store').json(body);
}

/** IP as seen by Vercel's edge network — used only for login rate limiting. */
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

module.exports = { str, newId, send, clientIp, LEVELS, STATUSES, TYPES, CHECK_TAGS };
