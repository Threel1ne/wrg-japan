'use strict';

const storage = require('../lib/storage');
const { isAdmin } = require('../lib/auth');
const { send, str } = require('../lib/helpers');

// Returns a short-lived URL the browser uploads DIRECTLY to Supabase Storage —
// the file bytes never pass through this function, so Vercel's request body
// size limit never applies to uploads (only to this small JSON exchange).
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  if (!isAdmin(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบก่อนจึงจะแก้ไขได้' });

  const body = req.body || {};
  const path = str(body.path, 1000);
  const name = str(body.name, 300).trim();
  if (!name) return send(res, 400, { error: 'ไม่มีชื่อไฟล์' });

  try {
    const { signedUrl } = await storage.createUploadUrl(path, name);
    send(res, 200, { ok: true, signedUrl });
  } catch (err) {
    console.error('[api/files-upload-url]', err.message);
    send(res, 400, { error: 'เตรียมอัปโหลดไม่สำเร็จ (ชื่อไฟล์นี้อาจมีอยู่แล้ว)' });
  }
};
