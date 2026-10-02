'use strict';

const { loadState } = require('../lib/db');
const { isRateLimited, clearRateLimit } = require('../lib/auth');
const { send, str, clientIp } = require('../lib/helpers');

// Public on purpose, but reveals nothing by itself: a visitor must already
// know which member they're asking about AND that member's exact date of
// birth before any of the sensitive profile (passport, DOB, food note, …)
// comes back. Rate-limited per IP so DOB can't be brute-forced.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  const ip = clientIp(req);
  const body = req.body || {};
  const teamKey = str(body.teamKey, 40);
  const memberIndex = Number(body.memberIndex);
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
    send(res, 200, { ok: true, profile: member.profile, verified: member.verified || null });
  } catch (err) {
    console.error('[api/verify-lookup]', err.message);
    send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
  }
};
