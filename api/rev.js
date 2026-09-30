'use strict';

const { loadRev } = require('../lib/db');
const { isAdmin } = require('../lib/auth');
const { send } = require('../lib/helpers');

// Cheap poll target — clients hit this every 15s to spot changes.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  try {
    const rev = await loadRev();
    send(res, 200, { rev, admin: isAdmin(req) });
  } catch (err) {
    console.error('[api/rev]', err.message);
    send(res, 500, { error: 'โหลดข้อมูลไม่สำเร็จ' });
  }
};
