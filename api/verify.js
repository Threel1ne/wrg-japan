'use strict';

const { loadState, saveState } = require('../lib/db');
const { isRateLimited, clearRateLimit } = require('../lib/auth');
const { send, str, clientIp } = require('../lib/helpers');

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Both public on purpose, merged into one function (Vercel's Hobby plan caps
// a deployment at 12 serverless functions):
//
// op "lookup" — the date of birth alone identifies the member (no two
// *different people* share one), so that's the only input; whoever it
// belongs to gets their own sensitive profile data (passport, DOB, food
// note, …) back. A person listed on more than one team roster (e.g. a
// mentor on both Soccer 4x4 and Ball Fighting) has the same DOB on both
// entries — those are grouped by national ID (or name, as a fallback) into
// one merged person rather than rejected as an ambiguous collision; only a
// DOB genuinely shared by two *different* people still errors out.
// Rate-limited per IP so DOB can't be brute-forced across the whole roster.
//
// op "confirm" — stamps a verified timestamp on every team entry for that
// person at once (one for a normal member, two for someone on both
// rosters). Can't change any other data.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  const body = req.body || {};
  const op = body.op;

  if (op === 'lookup') {
    const ip = clientIp(req);
    const dob = str(body.dob, 40);
    try {
      if (await isRateLimited(`verify:${ip}`)) {
        return send(res, 429, { error: 'ลองมากเกินไป กรุณารอ 15 นาทีแล้วลองใหม่' });
      }
      if (!dob) return send(res, 400, { error: 'กรุณากรอกวันเกิด' });

      const state = await loadState();
      const matches = [];
      for (const [teamKey, team] of Object.entries(state.teams)) {
        team.members.forEach((member, memberIndex) => {
          if (member.profile?.dob === dob) matches.push({ teamKey, memberIndex, team, member });
        });
      }

      if (!matches.length) {
        return send(res, 404, { error: 'ไม่พบข้อมูลที่ตรงกับวันเกิดนี้ กรุณาตรวจสอบวันที่อีกครั้ง หรือติดต่อผู้ดูแลทีม' });
      }

      const identityKey = (m) => m.member.profile?.nationalId || norm(m.member.name);
      const groups = new Map();
      for (const m of matches) {
        const k = identityKey(m);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(m);
      }
      if (groups.size > 1) {
        // a DOB genuinely shared by two different people — can't safely
        // tell them apart, so refuse rather than show the wrong person's data.
        return send(res, 409, { error: 'พบข้อมูลมากกว่าหนึ่งรายการสำหรับวันเกิดนี้ กรุณาติดต่อผู้ดูแลทีม' });
      }

      await clearRateLimit(`verify:${ip}`);
      const entries = [...groups.values()][0];
      const first = entries[0].member;

      const seenEvents = new Set();
      const events = [];
      for (const e of entries) {
        for (const ev of (e.member.events || [])) {
          const k = ev.id || `${ev.label}|${ev.date}|${ev.time}`;
          if (!seenEvents.has(k)) { seenEvents.add(k); events.push(ev); }
        }
      }
      const verifiedAt = entries.map((e) => e.member.verified).filter(Boolean).sort().pop() || null;

      return send(res, 200, {
        ok: true,
        teams: entries.map((e) => ({ teamKey: e.teamKey, memberIndex: e.memberIndex, teamLabel: e.team.name, matches: e.team.matches })),
        name: first.name, code: first.code, role: first.role, mainEvent: first.mainEvent,
        events, profile: first.profile, verified: verifiedAt,
      });
    } catch (err) {
      console.error('[api/verify:lookup]', err.message);
      return send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
    }
  }

  if (op === 'confirm') {
    try {
      const targets = Array.isArray(body.targets) && body.targets.length
        ? body.targets
        : [{ teamKey: body.teamKey, memberIndex: body.memberIndex }];

      const state = await loadState();
      const now = new Date().toISOString();
      let any = false;
      for (const t of targets) {
        const teamKey = str(t.teamKey, 40);
        const memberIndex = Number(t.memberIndex);
        const team = state.teams[teamKey];
        const member = team && Number.isInteger(memberIndex) ? team.members[memberIndex] : null;
        if (member) { member.verified = now; any = true; }
      }
      if (!any) return send(res, 404, { error: 'ไม่พบรายชื่อนี้' });

      const { rev } = await saveState(state);
      return send(res, 200, { ok: true, verifiedAt: now, rev });
    } catch (err) {
      console.error('[api/verify:confirm]', err.message);
      return send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
    }
  }

  send(res, 400, { error: 'คำขอไม่ถูกต้อง' });
};
