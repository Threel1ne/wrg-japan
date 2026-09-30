'use strict';

const { loadState } = require('../lib/db');
const { isAdmin } = require('../lib/auth');
const { send } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  try {
    const state = await loadState();
    send(res, 200, { ...state, admin: isAdmin(req) });
  } catch (err) {
    console.error('[api/state]', err.message);
    send(res, 500, { error: 'โหลดข้อมูลไม่สำเร็จ' });
  }
};
