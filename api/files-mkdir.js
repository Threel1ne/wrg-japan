'use strict';

const storage = require('../lib/storage');
const { isAdmin } = require('../lib/auth');
const { send, str } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!isAdmin(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบก่อนจึงจะแก้ไขได้' });

  const body = req.body || {};
  const path = str(body.path, 1000);
  const name = str(body.name, 200).trim();
  if (!name) return send(res, 400, { error: 'กรุณาตั้งชื่อโฟลเดอร์' });

  try {
    await storage.createFolder(path, name);
    send(res, 200, { ok: true });
  } catch (err) {
    console.error('[api/files-mkdir]', err.message);
    send(res, 400, { error: 'สร้างโฟลเดอร์ไม่สำเร็จ (ชื่อนี้อาจมีอยู่แล้ว)' });
  }
};
