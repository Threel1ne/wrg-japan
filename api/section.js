'use strict';

const { loadState, saveState } = require('../lib/db');
const { isAdmin } = require('../lib/auth');
const { send, str } = require('../lib/helpers');

// Escape hatch for the bulk sections — the client edits these as raw JSON.
module.exports = async (req, res) => {
  if (req.method !== 'PUT') return send(res, 405, { error: 'method not allowed' });
  if (!isAdmin(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบก่อนจึงจะแก้ไขได้' });

  const body = req.body || {};

  try {
    const section = str(body.section, 40);
    if (!['itinerary', 'schedule', 'notes', 'meta', 'travel'].includes(section)) {
      return send(res, 400, { error: 'ส่วนนี้แก้ไขไม่ได้' });
    }
    if (body.value === undefined || body.value === null) return send(res, 400, { error: 'ไม่มีข้อมูล' });

    const state = await loadState();
    state[section] = body.value;
    const { rev } = await saveState(state);
    send(res, 200, { ok: true, rev });
  } catch (err) {
    console.error('[api/section]', err.message);
    send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
  }
};
