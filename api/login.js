'use strict';

const { checkPassword, issueSessionCookie, isRateLimited, clearRateLimit } = require('../lib/auth');
const { send, clientIp } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const ip = clientIp(req);
  try {
    if (await isRateLimited(ip)) {
      return send(res, 429, { error: 'ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอ 15 นาที' });
    }
    const body = req.body || {};
    if (!checkPassword(body.password)) return send(res, 401, { error: 'รหัสผ่านไม่ถูกต้อง' });
    await clearRateLimit(ip);
    res.setHeader('Set-Cookie', issueSessionCookie());
    send(res, 200, { ok: true });
  } catch (err) {
    console.error('[api/login]', err.message);
    send(res, 500, { error: 'เข้าสู่ระบบไม่สำเร็จ' });
  }
};
