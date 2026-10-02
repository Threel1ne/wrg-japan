'use strict';

const { loadState, saveState } = require('../lib/db');
const { send, str } = require('../lib/helpers');

// Public on purpose — this is how a team member confirms their own listed
// details are correct, before they've ever logged in as admin. It can only
// ever stamp a timestamp on one existing member; it can't change any data.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  const body = req.body || {};
  const teamKey = str(body.teamKey, 40);
  const memberIndex = Number(body.memberIndex);

  try {
    const state = await loadState();
    const team = state.teams[teamKey];
    if (!team) return send(res, 404, { error: 'ไม่พบทีมนี้' });
    const member = team.members[memberIndex];
    if (!Number.isInteger(memberIndex) || !member) return send(res, 404, { error: 'ไม่พบรายชื่อนี้' });

    member.verified = new Date().toISOString();
    const { rev } = await saveState(state);
    send(res, 200, { ok: true, verifiedAt: member.verified, rev });
  } catch (err) {
    console.error('[api/verify-member]', err.message);
    send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
  }
};
