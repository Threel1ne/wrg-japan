'use strict';

const mysql = require('mysql2/promise');

let pool;

/** One shared connection pool per serverless instance — created lazily so a
    cold start doesn't pay the connection cost until a request actually needs it. */
function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 5,
      // Vercel's serverless MySQL guidance: keep pools small — each concurrent
      // function instance gets its own pool, so a high per-instance limit can
      // exhaust the database's total connection cap under load.
      ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: true },
    });
  }
  return pool;
}

/** Reads the single app_state row. Throws if the schema hasn't been applied
    yet — see sql/schema.sql and scripts/migrate-from-json.js. */
async function loadState() {
  const [rows] = await getPool().query('SELECT data, rev, updated_at FROM app_state WHERE id = 1');
  if (!rows.length) {
    throw new Error('app_state row missing — run scripts/migrate-from-json.js once against this database');
  }
  const row = rows[0];
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return { ...data, rev: row.rev, updatedAt: row.updated_at };
}

/** Replaces the whole document and bumps rev in one atomic statement, so two
    concurrent admin saves can't interleave into a half-applied state. */
async function saveState(nextData) {
  const { rev: _rev, updatedAt: _u, ...doc } = nextData;
  const [result] = await getPool().query(
    'UPDATE app_state SET data = ?, rev = rev + 1 WHERE id = 1',
    [JSON.stringify(doc)]
  );
  if (result.affectedRows !== 1) throw new Error('save failed — app_state row missing');
  const [rows] = await getPool().query('SELECT rev, updated_at FROM app_state WHERE id = 1');
  return { rev: rows[0].rev, updatedAt: rows[0].updated_at };
}

/** Cheap poll target — just the rev, no JSON parse/serialize. */
async function loadRev() {
  const [rows] = await getPool().query('SELECT rev FROM app_state WHERE id = 1');
  if (!rows.length) throw new Error('app_state row missing');
  return rows[0].rev;
}

module.exports = { getPool, loadState, saveState, loadRev };
