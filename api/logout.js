'use strict';

const { clearSessionCookie } = require('../lib/auth');
const { send } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  res.setHeader('Set-Cookie', clearSessionCookie());
  send(res, 200, { ok: true });
};
