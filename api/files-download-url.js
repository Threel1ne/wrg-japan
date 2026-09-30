'use strict';

const storage = require('../lib/storage');
const { send, str } = require('../lib/helpers');

// Read-only — anyone can download, same as the rest of the site's content.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  const path = str(req.query?.path, 1000);
  const name = str(req.query?.name, 300);
  if (!name) return send(res, 400, { error: 'ไม่มีชื่อไฟล์' });

  try {
    const signedUrl = await storage.createDownloadUrl(path, name);
    send(res, 200, { ok: true, signedUrl });
  } catch (err) {
    console.error('[api/files-download-url]', err.message);
    send(res, 404, { error: 'ไม่พบไฟล์นี้' });
  }
};
