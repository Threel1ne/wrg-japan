'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(DATA_DIR, 'seed.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

// ---------------------------------------------------------------- persistence

let db = null;
let writeQueue = Promise.resolve();

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.copyFileSync(SEED_FILE, DB_FILE);
    console.log('[db] created data/db.json from seed');
  }
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (typeof db.rev !== 'number') db.rev = 1;
}

// Serialised, atomic writes: never leaves a half-written db.json behind.
function saveDb() {
  db.rev += 1;
  db.updatedAt = new Date().toISOString();
  const snapshot = JSON.stringify(db, null, 2);
  writeQueue = writeQueue.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fsp.writeFile(tmp, snapshot, 'utf8');
    await fsp.rename(tmp, DB_FILE);
  }).catch((err) => console.error('[db] write failed:', err));
  return writeQueue;
}

// ------------------------------------------------------------------ passwords

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function loadOrCreateAdmin() {
  if (fs.existsSync(ADMIN_FILE)) return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));

  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(ADMIN_FILE, JSON.stringify({ salt, hash: hashPassword(password, salt) }, null, 2));
  fs.chmodSync(ADMIN_FILE, 0o600);

  if (!process.env.ADMIN_PASSWORD) {
    const note = path.join(DATA_DIR, 'FIRST-RUN-PASSWORD.txt');
    fs.writeFileSync(note, `Admin password: ${password}\n\nLog in once, then delete this file.\n`);
    fs.chmodSync(note, 0o600);
    console.log('\n' + '='.repeat(54));
    console.log('  ADMIN PASSWORD (generated once):  ' + password);
    console.log('  also saved to data/FIRST-RUN-PASSWORD.txt — delete it');
    console.log('  after logging in. Reset: `node server.js --set-password`');
    console.log('='.repeat(54) + '\n');
  }
  return JSON.parse(fs.readFileSync(ADMIN_FILE, 'utf8'));
}

let admin = null;

function checkPassword(password) {
  if (typeof password !== 'string' || !password) return false;
  const candidate = Buffer.from(hashPassword(password, admin.salt), 'hex');
  const expected = Buffer.from(admin.hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ------------------------------------------------------------------- sessions

const sessions = new Map(); // token -> expiresAt
const loginAttempts = new Map(); // ip -> { count, resetAt }

function issueSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function isAdmin(req) {
  const token = parseCookies(req).wrg_sess;
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) { sessions.delete(token); return false; }
  return true;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 8;
}

// -------------------------------------------------------------------- helpers

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readJsonBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const newId = () => crypto.randomBytes(8).toString('hex');
const LEVELS = new Set(['info', 'important', 'urgent']);

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
// member's date of birth.
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

// ---------------------------------------------------------------------- admin

const ROUTES = {
  'POST /api/login': async (req, res) => {
    const ip = req.socket.remoteAddress || 'unknown';
    if (rateLimited(ip)) return send(res, 429, { error: 'ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอ 15 นาที' });
    const body = await readJsonBody(req);
    if (!checkPassword(body.password)) return send(res, 401, { error: 'รหัสผ่านไม่ถูกต้อง' });
    loginAttempts.delete(ip);
    const token = issueSession();
    const secure = req.headers['x-forwarded-proto'] === 'https' ? ' Secure;' : '';
    send(res, 200, { ok: true }, {
      'Set-Cookie': `wrg_sess=${token}; HttpOnly; SameSite=Lax; Path=/;${secure} Max-Age=${SESSION_TTL_MS / 1000}`,
    });
  },

  'POST /api/logout': async (req, res) => {
    const token = parseCookies(req).wrg_sess;
    if (token) sessions.delete(token);
    send(res, 200, { ok: true }, { 'Set-Cookie': 'wrg_sess=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  },

  'GET /api/state': async (req, res) => {
    const admin = isAdmin(req);
    send(res, 200, { ...(admin ? db : publicState(db)), admin });
  },

  // Cheap poll target — clients hit this every 15s to spot changes.
  'GET /api/rev': async (req, res) => {
    send(res, 200, { rev: db.rev, admin: isAdmin(req) });
  },

  'POST /api/announcements': async (req, res) => {
    const body = await readJsonBody(req);
    const now = new Date().toISOString();
    const item = {
      id: newId(),
      title: str(body.title, 200) || 'ไม่มีหัวข้อ',
      body: str(body.body, 8000),
      level: LEVELS.has(body.level) ? body.level : 'info',
      teams: Array.isArray(body.teams) && body.teams.length ? body.teams.map((t) => str(t, 40)) : ['all'],
      pinned: Boolean(body.pinned),
      createdAt: now,
      updatedAt: now,
    };
    db.announcements.unshift(item);
    await saveDb();
    send(res, 200, { ok: true, item, rev: db.rev });
  },

  'PUT /api/announcements': async (req, res) => {
    const body = await readJsonBody(req);
    const item = db.announcements.find((a) => a.id === body.id);
    if (!item) return send(res, 404, { error: 'ไม่พบประกาศนี้' });
    if (body.title !== undefined) item.title = str(body.title, 200);
    if (body.body !== undefined) item.body = str(body.body, 8000);
    if (body.level !== undefined && LEVELS.has(body.level)) item.level = body.level;
    if (Array.isArray(body.teams)) item.teams = body.teams.map((t) => str(t, 40));
    if (body.pinned !== undefined) item.pinned = Boolean(body.pinned);
    item.updatedAt = new Date().toISOString();
    await saveDb();
    send(res, 200, { ok: true, item, rev: db.rev });
  },

  'DELETE /api/announcements': async (req, res) => {
    const body = await readJsonBody(req);
    const before = db.announcements.length;
    db.announcements = db.announcements.filter((a) => a.id !== body.id);
    if (db.announcements.length === before) return send(res, 404, { error: 'ไม่พบประกาศนี้' });
    await saveDb();
    send(res, 200, { ok: true, rev: db.rev });
  },

  // Replaces one team wholesale — the client always sends the full object back.
  'PUT /api/team': async (req, res) => {
    const body = await readJsonBody(req);
    const key = str(body.key, 40);
    if (!db.teams[key]) return send(res, 404, { error: 'ไม่พบทีมนี้' });
    const t = body.team || {};
    const current = db.teams[key];
    db.teams[key] = {
      ...current,
      name: str(t.name, 80) || current.name,
      nameTh: str(t.nameTh, 80),
      code: str(t.code, 60),
      summary: str(t.summary, 2000),
      gameDay: str(t.gameDay, 120),
      arena: str(t.arena, 120),
      members: (Array.isArray(t.members) ? t.members : []).slice(0, 60).map((m) => ({
        name: str(m.name, 120), role: str(m.role, 120), code: str(m.code, 60),
        mainEvent: ['soccer4x4', 'ballfighting', 'both', 'none'].includes(m.mainEvent) ? m.mainEvent : '',
        // set only by the public /api/verify route (op "confirm") — preserved here
        // so a normal admin edit (adding a match, etc.) doesn't wipe it.
        verified: typeof m.verified === 'string' ? m.verified : null,
        profile: sanitizeProfile(m.profile),
        // other events this member also competes in (e.g. SumoBOT Junior) —
        // small dated entries, same shape as team matches, so each person
        // gets a real timetable instead of a plain label.
        // events used to be plain strings; migrate old entries in place so a
        // legacy tag becomes the label instead of silently emptying out.
        events: (Array.isArray(m.events) ? m.events : []).slice(0, 12).map((e) => {
          const src = typeof e === 'string' ? { label: e } : (e || {});
          return {
            id: str(src.id, 40) || newId(),
            label: str(src.label, 200),
            date: str(src.date, 40),
            time: str(src.time, 60),
            status: str(src.status, 40) || 'scheduled',
            note: str(src.note, 1000),
            // 'competition' = an actual match, 'other' = ceremony/logistics
            // (awarding, opening, etc.) — drives bar colour on the timeline.
            type: src.type === 'other' ? 'other' : 'competition',
          };
        }),
      })),
      matches: (Array.isArray(t.matches) ? t.matches : []).slice(0, 100).map((m) => ({
        id: str(m.id, 40) || newId(),
        date: str(m.date, 40),
        time: str(m.time, 60),
        label: str(m.label, 200),
        status: str(m.status, 40) || 'scheduled',
        note: str(m.note, 1000),
        type: m.type === 'other' ? 'other' : 'competition',
      })),
      checklist: (Array.isArray(t.checklist) ? t.checklist : []).slice(0, 100).map((c) => ({
        id: str(c.id, 40) || newId(), text: str(c.text, 300), done: Boolean(c.done),
        // 'carry' = นำขึ้นเครื่อง, 'cargo' = โหลดใต้เครื่อง, '' = ยังไม่ระบุ
        tag: ['carry', 'cargo'].includes(c.tag) ? c.tag : '',
      })),
    };
    await saveDb();
    send(res, 200, { ok: true, team: db.teams[key], rev: db.rev });
  },

  // Both public on purpose, merged into one route like the Vercel side's
  // api/verify.js (there it's to stay under the Hobby plan's 12-function
  // cap; kept the same shape here purely so the two modes share one app.js).
  //
  // op "lookup" — the date of birth alone identifies the member (no two
  // members share one), so that's the only input; whoever it belongs to
  // gets their own sensitive profile data (passport, DOB, food note, …)
  // back. Rate-limited per IP so DOB can't be brute-forced across the
  // whole roster.
  //
  // op "confirm" — stamps a verified timestamp once the person agrees
  // their details are correct. Can't change any data, just that timestamp.
  'POST /api/verify': async (req, res) => {
    const body = await readJsonBody(req);

    if (body.op === 'lookup') {
      const ip = `verify:${req.socket.remoteAddress || 'unknown'}`;
      if (rateLimited(ip)) return send(res, 429, { error: 'ลองมากเกินไป กรุณารอ 15 นาทีแล้วลองใหม่' });
      const dob = str(body.dob, 40);
      if (!dob) return send(res, 400, { error: 'กรุณากรอกวันเกิด' });

      const matches = [];
      for (const [teamKey, team] of Object.entries(db.teams)) {
        team.members.forEach((member, memberIndex) => {
          if (member.profile?.dob === dob) matches.push({ teamKey, memberIndex, team, member });
        });
      }
      if (!matches.length) {
        return send(res, 404, { error: 'ไม่พบข้อมูลที่ตรงกับวันเกิดนี้ กรุณาตรวจสอบวันที่อีกครั้ง หรือติดต่อผู้ดูแลทีม' });
      }
      if (matches.length > 1) {
        return send(res, 409, { error: 'พบข้อมูลมากกว่าหนึ่งรายการสำหรับวันเกิดนี้ กรุณาติดต่อผู้ดูแลทีม' });
      }

      loginAttempts.delete(ip);
      const { teamKey, memberIndex, team, member } = matches[0];
      return send(res, 200, {
        ok: true, teamKey, memberIndex, teamLabel: team.name,
        name: member.name, code: member.code, role: member.role, mainEvent: member.mainEvent,
        events: member.events, profile: member.profile, verified: member.verified || null,
        teamMatches: team.matches,
      });
    }

    if (body.op === 'confirm') {
      const teamKey = str(body.teamKey, 40);
      const memberIndex = Number(body.memberIndex);
      const team = db.teams[teamKey];
      if (!team) return send(res, 404, { error: 'ไม่พบทีมนี้' });
      const member = team.members[memberIndex];
      if (!Number.isInteger(memberIndex) || !member) return send(res, 404, { error: 'ไม่พบรายชื่อนี้' });
      member.verified = new Date().toISOString();
      await saveDb();
      return send(res, 200, { ok: true, verifiedAt: member.verified, rev: db.rev });
    }

    send(res, 400, { error: 'คำขอไม่ถูกต้อง' });
  },

  // Escape hatch for the bulk sections — the client edits these as raw JSON.
  'PUT /api/section': async (req, res) => {
    const body = await readJsonBody(req);
    const section = str(body.section, 40);
    if (!['itinerary', 'schedule', 'notes', 'meta', 'travel'].includes(section)) {
      return send(res, 400, { error: 'ส่วนนี้แก้ไขไม่ได้' });
    }
    if (body.value === undefined || body.value === null) return send(res, 400, { error: 'ไม่มีข้อมูล' });
    db[section] = body.value;
    await saveDb();
    send(res, 200, { ok: true, rev: db.rev });
  },
};

const PUBLIC_ROUTES = new Set([
  'POST /api/login', 'POST /api/logout', 'GET /api/state', 'GET /api/rev', 'POST /api/verify',
]);

// ------------------------------------------------------------- static serving

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return send(res, 403, 'Forbidden');
  }
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) return send(res, 404, 'Not found');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    // Unknown path -> hand the SPA its shell so client routing still works.
    if (!path.extname(rel)) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
    } else {
      send(res, 404, 'Not found');
    }
  }
}

// ---------------------------------------------------------------------- serve

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (!urlPath.startsWith('/api/')) return serveStatic(req, res, urlPath);

  const key = `${req.method} ${urlPath}`;
  const handler = ROUTES[key];
  if (!handler) return send(res, 404, { error: 'ไม่พบ endpoint นี้' });

  if (!PUBLIC_ROUTES.has(key) && !isAdmin(req)) {
    return send(res, 401, { error: 'ต้องเข้าสู่ระบบก่อนจึงจะแก้ไขได้' });
  }

  try {
    await handler(req, res);
  } catch (err) {
    console.error('[api]', key, err.message);
    if (!res.headersSent) send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
  }
});

// ----------------------------------------------------------------- entrypoint

if (process.argv.includes('--set-password')) {
  const password = process.argv[process.argv.indexOf('--set-password') + 1] || process.env.ADMIN_PASSWORD;
  if (!password) {
    console.error('Usage: node server.js --set-password <new-password>');
    process.exit(1);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(ADMIN_FILE, JSON.stringify({ salt, hash: hashPassword(password, salt) }, null, 2));
  fs.chmodSync(ADMIN_FILE, 0o600);
  console.log('Admin password updated. Restart the server.');
  process.exit(0);
}

loadDb();
admin = loadOrCreateAdmin();

server.listen(PORT, HOST, () => {
  console.log(`WRG2026 Japan team site  →  http://localhost:${PORT}`);
  console.log(`Admin panel              →  http://localhost:${PORT}  (กดปุ่ม "ผู้ดูแล" มุมขวาบน)`);
});
