'use strict';

const storage = require('../lib/storage');
const { send, str } = require('../lib/helpers');

// Read-only — anyone can browse, same as the rest of the site's content.
module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
  try {
    const path = str(req.query?.path, 1000);
    const { folders, files } = await storage.list(path);
    send(res, 200, { folders, files });
  } catch (err) {
    console.error('[api/files-list]', err.message);
    send(res, 500, { error: 'โหลดรายการไฟล์ไม่สำเร็จ' });
  }
};
