'use strict';

const { loadState, saveState } = require('../lib/db');
const { isRateLimited, clearRateLimit } = require('../lib/auth');
const { send, str, clientIp } = require('../lib/helpers');

// Both public on purpose, merged into one function (Vercel's Hobby plan caps
// a deployment at 12 serverless functions):
//
// op "lookup" — a visitor must already know which member they're asking
// about AND that member's exact date of birth before any sensitive profile
// data (passport, DOB, food note, …) comes back. Rate-limited per IP so DOB
// can't be brute-forced.
//
// op "confirm" — stamps a verified timestamp once the person agrees their
// details are correct. Can't change any data, just that one timestamp.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  const body = req.body || {};
  const op = body.op;
  const teamKey = str(body.teamKey, 40);
  const memberIndex = Number(body.memberIndex);

  if (op === 'lookup') {
    const ip = clientIp(req);
    const dob = str(body.dob, 40);
    try {
      if (await isRateLimited(`verify:${ip}`)) {
        return send(res, 429, { error: 'ลองมากเกินไป กรุณารอ 15 นาทีแล้วลองใหม่' });
      }

      const state = await loadState();
      const team = state.teams[teamKey];
      const member = team && Number.isInteger(memberIndex) ? team.members[memberIndex] : null;
      if (!member) return send(res, 404, { error: 'ไม่พบรายชื่อนี้' });

      const onFile = member.profile?.dob || '';
      if (!onFile) return send(res, 404, { error: 'ยังไม่มีข้อมูลวันเกิดของคุณในระบบ กรุณาติดต่อผู้ดูแลทีม' });
      if (!dob || dob !== onFile) {
        return send(res, 401, { error: 'วันเกิดไม่ตรงกับข้อมูลที่มี กรุณาลองใหม่อีกครั้ง' });
      }

      await clearRateLimit(`verify:${ip}`);
      return send(res, 200, { ok: true, profile: member.profile, verified: member.verified || null });
    } catch (err) {
      console.error('[api/verify:lookup]', err.message);
      return send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
    }
  }

  if (op === 'confirm') {
    try {
      const state = await loadState();
      const team = state.teams[teamKey];
      if (!team) return send(res, 404, { error: 'ไม่พบทีมนี้' });
      const member = team.members[memberIndex];
      if (!Number.isInteger(memberIndex) || !member) return send(res, 404, { error: 'ไม่พบรายชื่อนี้' });

      member.verified = new Date().toISOString();
      const { rev } = await saveState(state);
      return send(res, 200, { ok: true, verifiedAt: member.verified, rev });
    } catch (err) {
      console.error('[api/verify:confirm]', err.message);
      return send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
    }
  }

  send(res, 400, { error: 'คำขอไม่ถูกต้อง' });
};
