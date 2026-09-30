'use strict';

const { loadState, saveState } = require('../lib/db');
const { isAdmin } = require('../lib/auth');
const { send, str, newId, LEVELS } = require('../lib/helpers');

module.exports = async (req, res) => {
  if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return send(res, 405, { error: 'method not allowed' });
  if (!isAdmin(req)) return send(res, 401, { error: 'ต้องเข้าสู่ระบบก่อนจึงจะแก้ไขได้' });

  const body = req.body || {};

  try {
    const state = await loadState();

    if (req.method === 'POST') {
      const now = new Date().toISOString();
      const item = {
        id: newId(),
        title: str(body.title, 200) || 'ไม่มีหัวข้อ',
        body: str(body.body, 8000),
        level: LEVELS.has(body.level) ? body.level : 'info',
        teams: Array.isArray(body.teams) && body.teams.length ? body.teams.map((t) => str(t, 40)) : ['all'],
        pinned: Boolean(body.pinned),
        createdAt: now,
        updatedAt: now,
      };
      state.announcements.unshift(item);
      const { rev } = await saveState(state);
      return send(res, 200, { ok: true, item, rev });
    }

    if (req.method === 'PUT') {
      const item = state.announcements.find((a) => a.id === body.id);
      if (!item) return send(res, 404, { error: 'ไม่พบประกาศนี้' });
      if (body.title !== undefined) item.title = str(body.title, 200);
      if (body.body !== undefined) item.body = str(body.body, 8000);
      if (body.level !== undefined && LEVELS.has(body.level)) item.level = body.level;
      if (Array.isArray(body.teams)) item.teams = body.teams.map((t) => str(t, 40));
      if (body.pinned !== undefined) item.pinned = Boolean(body.pinned);
      item.updatedAt = new Date().toISOString();
      const { rev } = await saveState(state);
      return send(res, 200, { ok: true, item, rev });
    }

    // DELETE
    const before = state.announcements.length;
    state.announcements = state.announcements.filter((a) => a.id !== body.id);
    if (state.announcements.length === before) return send(res, 404, { error: 'ไม่พบประกาศนี้' });
    const { rev } = await saveState(state);
    return send(res, 200, { ok: true, rev });
  } catch (err) {
    console.error('[api/announcements]', err.message);
    send(res, 400, { error: err.message || 'คำขอไม่ถูกต้อง' });
  }
};
