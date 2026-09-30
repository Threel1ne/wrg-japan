'use strict';

const crypto = require('node:crypto');
const { getPool } = require('./db');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

// ------------------------------------------------------------------ password

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** ADMIN_SALT/ADMIN_HASH are generated once via scripts/hash-password.js and
    stored as Vercel env vars — the plaintext password is never stored anywhere. */
function checkPassword(password) {
  const salt = process.env.ADMIN_SALT;
  const expectedHash = process.env.ADMIN_HASH;
  if (!salt || !expectedHash) throw new Error('ADMIN_SALT / ADMIN_HASH not configured');
  if (typeof password !== 'string' || !password) return false;
  const candidate = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ------------------------------------------------------------------ sessions
//
// No server memory to hold sessions in (each request may hit a different
// serverless instance), so the session lives entirely in a signed cookie:
// "<expiryMs>.<hmac>". Nothing to look up — verifying the signature IS
// verifying the session. SESSION_SECRET is a random string set once as a
// Vercel env var; anyone who can forge a valid HMAC without it would need to
// have the secret already.

function sign(expiryMs) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return crypto.createHmac('sha256', secret).update(String(expiryMs)).digest('hex');
}

function issueSessionCookie() {
  const expiryMs = Date.now() + SESSION_TTL_MS;
  const token = `${expiryMs}.${sign(expiryMs)}`;
  return `admin_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
}

function clearSessionCookie() {
  return 'admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAdmin(req) {
  const token = parseCookies(req).admin_session;
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expiryMs = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(expiryMs) || expiryMs < Date.now()) return false;
  let expected;
  try { expected = Buffer.from(sign(expiryMs), 'hex'); } catch { return false; }
  const got = Buffer.from(sig, 'hex');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

// -------------------------------------------------------------- rate limits

/** Postgres-backed so the limit is real across every serverless instance,
    not just whichever one happens to handle a given request. */
async function isRateLimited(ip) {
  const pool = getPool();
  const now = new Date();
  const { rows } = await pool.query('SELECT attempt_count, reset_at FROM login_attempts WHERE ip = $1', [ip]);

  if (!rows.length || rows[0].reset_at < now) {
    const resetAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      'INSERT INTO login_attempts (ip, attempt_count, reset_at) VALUES ($1, 1, $2) ' +
      'ON CONFLICT (ip) DO UPDATE SET attempt_count = 1, reset_at = EXCLUDED.reset_at',
      [ip, resetAt]
    );
    return false;
  }

  const nextCount = rows[0].attempt_count + 1;
  await pool.query('UPDATE login_attempts SET attempt_count = $1 WHERE ip = $2', [nextCount, ip]);
  return nextCount > 8;
}

async function clearRateLimit(ip) {
  await getPool().query('DELETE FROM login_attempts WHERE ip = $1', [ip]);
}

module.exports = {
  checkPassword, hashPassword,
  issueSessionCookie, clearSessionCookie, isAdmin, parseCookies,
  isRateLimited, clearRateLimit,
};
