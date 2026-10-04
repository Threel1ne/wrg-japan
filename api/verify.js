'use strict';

const { loadState } = require('../lib/db');
const { isAdmin, isRateLimited, clearRateLimit } = require('../lib/auth');
const { send, str, clientIp } = require('../lib/helpers');
const storage = require('../lib/storage');

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Every (teamKey, memberIndex) entry whose profile.dob matches, grouped by
    identity (national ID, falling back to name) — a person on more than one
    team roster (e.g. a mentor) has the same DOB on every entry, and those
    group into ONE person rather than being treated as a collision. Only a
    DOB genuinely shared by two *different* people returns more than one
    group, which every caller below treats as "can't safely tell them apart". */
function findIdentityGroup(state, dob) {
  const matches = [];
  for (const [teamKey, team] of Object.entries(state.teams)) {
    team.members.forEach((member, memberIndex) => {
      if (member.profile?.dob === dob) matches.push({ teamKey, memberIndex, team, member });
    });
  }
  if (!matches.length) return { entries: null, ambiguous: false };

  const identityKey = (m) => m.member.profile?.nationalId || norm(m.member.name);
  const groups = new Map();
  for (const m of matches) {
    const k = identityKey(m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  if (groups.size > 1) return { entries: null, ambiguous: true };
  return { entries: [...groups.values()][0], ambiguous: false };
}

/** The Supabase Storage folder a person's own documents live under — their
    national ID if they have one, else their (normalized) name. Same key a
    browser session derives after a successful DOB lookup, and the same key
    admin targets by passing teamKey+memberIndex (resolved server-side, never
    trusting a raw path from the client — see the admin-files-* ops below). */
function personFolder(member) {
  return member.profile?.nationalId || norm(member.name);
}

// Both public (DOB-gated, rate-limited per IP) and admin-only (cookie-gated)
// operations, all merged into one function — Vercel's Hobby plan caps a
// deployment at 12 serverless functions.
//
// Public, read-only, re-proving identity with the correct "dob" on every
// request (there is no session):
//   lookup           — find + return a person's full record by DOB alone.
//   files-list         — list that person's own documents.
//   files-download-url  — a signed URL for one of their own documents.
//
// Admin (cookie-gated, no DOB needed — already authenticated), scoped to
// whichever (teamKey, memberIndex) admin passes, folder resolved server-side:
//   admin-files-list, admin-files-upload-url, admin-files-download-url,
//   admin-files-delete — full CRUD on any one person's documents.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  const body = req.body || {};
  const op = body.op;

  // ---------------------------------------------------------- admin file ops
  if (op && op.startsWith('admin-files-')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบก่อนจึงจะแก้ไขได้' });
    try {
      const state = await loadState();
      const teamKey = str(body.teamKey, 40);
      const memberIndex = Number(body.memberIndex);
      const team = state.teams[teamKey];
      const member = team && Number.isInteger(memberIndex) ? team.members[memberIndex] : null;
      if (!member) return send(res, 404, { error: 'ไม่พบรายชื่อนี้' });
      const folder = personFolder(member);

      if (op === 'admin-files-list') {
        const { files } = await storage.list(folder, storage.MEMBER_BUCKET);
        return send(res, 200, { ok: true, files });
      }
      if (op === 'admin-files-upload-url') {
        const name = str(body.name, 300).trim();
        if (!name) return send(res, 400, { error: 'ไม่มีชื่อไฟล์' });
        const { signedUrl } = await storage.createUploadUrl(folder, name, storage.MEMBER_BUCKET);
        return send(res, 200, { ok: true, signedUrl });
      }
      if (op === 'admin-files-download-url') {
        const name = str(body.name, 300);
        if (!name) return send(res, 400, { error: 'ไม่มีชื่อไฟล์' });
        const signedUrl = await storage.createDownloadUrl(folder, name, 3600, storage.MEMBER_BUCKET);
        return send(res, 200, { ok: true, signedUrl });
      }
      if (op === 'admin-files-delete') {
        const name = str(body.name, 300);
        if (!name) return send(res, 400, { error: 'ไม่มีชื่อไฟล์' });
        await storage.deleteFile(folder, name, storage.MEMBER_BUCKET);
        return send(res, 200, { ok: true });
      }
    } catch (err) {
      console.error(`[api/verify:${op}]`, err.message);
      return send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
    }
  }

  // ----------------------------------------------------------------- lookup
  if (op === 'lookup') {
    const ip = clientIp(req);
    const dob = str(body.dob, 40);
    try {
      if (await isRateLimited(`verify:${ip}`)) {
        return send(res, 429, { error: 'ลองมากเกินไป กรุณารอ 15 นาทีแล้วลองใหม่' });
      }
      if (!dob) return send(res, 400, { error: 'กรุณากรอกวันเกิด' });

      const state = await loadState();
      const { entries, ambiguous } = findIdentityGroup(state, dob);
      if (ambiguous) return send(res, 409, { error: 'พบข้อมูลมากกว่าหนึ่งรายการสำหรับวันเกิดนี้ กรุณาติดต่อผู้ดูแลทีม' });
      if (!entries) return send(res, 404, { error: 'ไม่พบข้อมูลที่ตรงกับวันเกิดนี้ กรุณาตรวจสอบวันที่อีกครั้ง หรือติดต่อผู้ดูแลทีม' });

      await clearRateLimit(`verify:${ip}`);
      const first = entries[0].member;

      const seenEvents = new Set();
      const events = [];
      for (const e of entries) {
        for (const ev of (e.member.events || [])) {
          const k = ev.id || `${ev.label}|${ev.date}|${ev.time}`;
          if (!seenEvents.has(k)) { seenEvents.add(k); events.push(ev); }
        }
      }

      return send(res, 200, {
        ok: true,
        teams: entries.map((e) => ({ teamKey: e.teamKey, memberIndex: e.memberIndex, teamLabel: e.team.name, matches: e.team.matches })),
        name: first.name, code: first.code, role: first.role, mainEvent: first.mainEvent,
        photoName: first.photoName || '',
        events, profile: first.profile,
      });
    } catch (err) {
      console.error('[api/verify:lookup]', err.message);
      return send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
    }
  }

  // ----------------------------------------------------- self-service files
  if (op === 'files-list' || op === 'files-download-url') {
    const dob = str(body.dob, 40);
    try {
      if (!dob) return send(res, 400, { error: 'กรุณากรอกวันเกิด' });
      const state = await loadState();
      const { entries, ambiguous } = findIdentityGroup(state, dob);
      if (ambiguous) return send(res, 409, { error: 'พบข้อมูลมากกว่าหนึ่งรายการสำหรับวันเกิดนี้ กรุณาติดต่อผู้ดูแลทีม' });
      if (!entries) return send(res, 404, { error: 'ไม่พบรายชื่อนี้' });
      const folder = personFolder(entries[0].member);

      if (op === 'files-list') {
        const { files } = await storage.list(folder, storage.MEMBER_BUCKET);
        return send(res, 200, { ok: true, files });
      }
      const name = str(body.name, 300);
      if (!name) return send(res, 400, { error: 'ไม่มีชื่อไฟล์' });
      const signedUrl = await storage.createDownloadUrl(folder, name, 3600, storage.MEMBER_BUCKET);
      return send(res, 200, { ok: true, signedUrl });
    } catch (err) {
      console.error(`[api/verify:${op}]`, err.message);
      return send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
    }
  }

  send(res, 400, { error: 'คำขอไม่ถูกต้อง' });
};
