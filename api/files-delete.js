'use strict';

const storage = require('../lib/storage');
const { isAdmin } = require('../lib/auth');
const { send, str } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!isAdmin(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบก่อนจึงจะแก้ไขได้' });

  const body = req.body || {};
  const path = str(body.path, 1000);
  const name = str(body.name, 300);
  const type = body.type === 'folder' ? 'folder' : 'file';
  if (!name) return send(res, 400, { error: 'ไม่มีชื่อรายการ' });

  try {
    if (type === 'folder') await storage.deleteFolder(path, name);
    else await storage.deleteFile(path, name);
    send(res, 200, { ok: true });
  } catch (err) {
    console.error('[api/files-delete]', err.message);
    send(res, 400, { error: 'ลบไม่สำเร็จ' });
  }
};
