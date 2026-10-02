'use strict';

const { loadState, saveState } = require('../lib/db');
const { isRateLimited, clearRateLimit } = require('../lib/auth');
const { send, str, clientIp } = require('../lib/helpers');

// Both public on purpose, merged into one function (Vercel's Hobby plan caps
// a deployment at 12 serverless functions):
//
// op "lookup" — the date of birth alone identifies the member (no two
// members share one), so that's the only input; whoever it belongs to gets
// their own sensitive profile data (passport, DOB, food note, …) back.
// Rate-limited per IP so DOB can't be brute-forced across the whole roster.
//
// op "confirm" — stamps a verified timestamp once the person agrees their
// details are correct. Can't change any data, just that one timestamp.
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
      if (matches.length > 1) {
        // shouldn't happen (DOB is meant to be unique across the roster) —
        // fail safe rather than show the wrong person's data.
        return send(res, 409, { error: 'พบข้อมูลมากกว่าหนึ่งรายการสำหรับวันเกิดนี้ กรุณาติดต่อผู้ดูแลทีม' });
      }

      await clearRateLimit(`verify:${ip}`);
      const { teamKey, memberIndex, team, member } = matches[0];
      return send(res, 200, {
        ok: true, teamKey, memberIndex, teamLabel: team.name,
        name: member.name, code: member.code, role: member.role, mainEvent: member.mainEvent,
        events: member.events, profile: member.profile, verified: member.verified || null,
      });
    } catch (err) {
      console.error('[api/verify:lookup]', err.message);
      return send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
    }
  }

  const teamKey = str(body.teamKey, 40);
  const memberIndex = Number(body.memberIndex);

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
