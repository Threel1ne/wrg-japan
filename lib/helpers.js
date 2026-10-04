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

/** GET /api/state is public — strip each member's sensitive profile (passport,
    date of birth, food notes, …) before it ever reaches a non-admin browser.
    A non-admin visitor only gets it back for one member at a time, from
    /api/verify (op "lookup"), after they've typed that member's date of birth. */
function publicState(state) {
  const teams = {};
  for (const [key, team] of Object.entries(state.teams)) {
    teams[key] = { ...team, members: team.members.map(({ profile, ...rest }) => rest) };
  }
  return { ...state, teams };
}

// Sensitive, DOB-gated fields (see /api/verify, op "lookup") — never sent to a
// non-admin browser via /api/state, only to someone who typed this exact
// member's date of birth. Shared by api/team.js (admin edits) and
// api/verify.js (self-service edits).
function sanitizeProfile(p) {
  const src = p || {};
  return {
    school: str(src.school, 160),
    passportNo: str(src.passportNo, 40),
    passportIssue: str(src.passportIssue, 40),
    passportExpiry: str(src.passportExpiry, 40),
    dob: str(src.dob, 40),
    city: str(src.city, 80),
    shirtSize: str(src.shirtSize, 20),
    foodNote: str(src.foodNote, 300),
    nationalId: str(src.nationalId, 20),
  };
}

module.exports = {
  str, newId, send, clientIp, publicState, sanitizeProfile,
  LEVELS, STATUSES, TYPES, CHECK_TAGS,
};
