'use strict';

const storage = require('../lib/storage');
const { isAdmin } = require('../lib/auth');
const { send, str } = require('../lib/helpers');

// One function handling every ไฟล์เอกสาร operation, dispatched by `op` —
// Vercel's Hobby plan caps a deployment at 12 serverless functions, so the
// 5 file-manager routes that used to be separate files (list, mkdir,
// upload-url, download-url, delete) are merged here instead.
module.exports = async (req, res) => {
  const op = req.method === 'GET' ? req.query?.op : (req.body || {}).op;

  if (req.method === 'GET' && op === 'list') {
    try {
      const path = str(req.query?.path, 1000);
      const { folders, files } = await storage.list(path);
      return send(res, 200, { folders, files });
    } catch (err) {
      console.error('[api/files:list]', err.message);
      return send(res, 500, { error: 'โหลดรายการไฟล์ไม่สำเร็จ' });
    }
  }

  if (req.method === 'GET' && op === 'download-url') {
    const path = str(req.query?.path, 1000);
    const name = str(req.query?.name, 300);
    if (!name) return send(res, 400, { error: 'ไม่มีชื่อไฟล์' });
    try {
      const signedUrl = await storage.createDownloadUrl(path, name);
      return send(res, 200, { ok: true, signedUrl });
    } catch (err) {
      console.error('[api/files:download-url]', err.message);
      return send(res, 404, { error: 'ไม่พบไฟล์นี้' });
    }
  }

  if (req.method === 'POST' && op === 'mkdir') {
    if (!isAdmin(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบก่อนจึงจะแก้ไขได้' });
    const body = req.body || {};
    const path = str(body.path, 1000);
    const name = str(body.name, 200).trim();
    if (!name) return send(res, 400, { error: 'กรุณาตั้งชื่อโฟลเดอร์' });
    try {
      await storage.createFolder(path, name);
      return send(res, 200, { ok: true });
    } catch (err) {
      console.error('[api/files:mkdir]', err.message);
      return send(res, 400, { error: 'สร้างโฟลเดอร์ไม่สำเร็จ (ชื่อนี้อาจมีอยู่แล้ว)' });
    }
  }

  if (req.method === 'POST' && op === 'upload-url') {
    if (!isAdmin(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบก่อนจึงจะแก้ไขได้' });
    const body = req.body || {};
    const path = str(body.path, 1000);
    const name = str(body.name, 300).trim();
    if (!name) return send(res, 400, { error: 'ไม่มีชื่อไฟล์' });
    try {
      const { signedUrl } = await storage.createUploadUrl(path, name);
      return send(res, 200, { ok: true, signedUrl });
    } catch (err) {
      console.error('[api/files:upload-url]', err.message);
      return send(res, 400, { error: 'เตรียมอัปโหลดไม่สำเร็จ (ชื่อไฟล์นี้อาจมีอยู่แล้ว)' });
    }
  }

  if (req.method === 'POST' && op === 'delete') {
    if (!isAdmin(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบก่อนจึงจะแก้ไขได้' });
    const body = req.body || {};
    const path = str(body.path, 1000);
    const name = str(body.name, 300);
    const type = body.type === 'folder' ? 'folder' : 'file';
    if (!name) return send(res, 400, { error: 'ไม่มีชื่อรายการ' });
    try {
      if (type === 'folder') await storage.deleteFolder(path, name);
      else await storage.deleteFile(path, name);
      return send(res, 200, { ok: true });
    } catch (err) {
      console.error('[api/files:delete]', err.message);
      return send(res, 400, { error: 'ลบไม่สำเร็จ' });
    }
  }

  send(res, 400, { error: 'คำขอไม่ถูกต้อง' });
};
