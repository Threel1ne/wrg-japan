'use strict';

const { loadState, saveState } = require('../lib/db');
const { isAdmin } = require('../lib/auth');
const { send, str, newId } = require('../lib/helpers');

// Sensitive, DOB-gated fields (see /api/verify-lookup) — never sent to a
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

// Replaces one team wholesale — the client always sends the full object back.
module.exports = async (req, res) => {
  if (req.method !== 'PUT') return send(res, 405, { error: 'method not allowed' });
  if (!isAdmin(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบก่อนจึงจะแก้ไขได้' });

  const body = req.body || {};

  try {
    const state = await loadState();
    const key = str(body.key, 40);
    if (!state.teams[key]) return send(res, 404, { error: 'ไม่พบทีมนี้' });
    const t = body.team || {};
    const current = state.teams[key];

    state.teams[key] = {
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
        // set only by the public /api/verify-member endpoint — preserved
        // here so a normal admin edit (adding a match, etc.) doesn't wipe it.
        verified: typeof m.verified === 'string' ? m.verified : null,
        profile: sanitizeProfile(m.profile),
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
        tag: ['carry', 'cargo'].includes(c.tag) ? c.tag : '',
      })),
    };

    const { rev } = await saveState(state);
    send(res, 200, { ok: true, team: state.teams[key], rev });
  } catch (err) {
    console.error('[api/team]', err.message);
    send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
  }
};
