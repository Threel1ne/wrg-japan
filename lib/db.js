'use strict';

const { Pool } = require('pg');

let pool;

/** One shared connection pool per serverless instance — created lazily so a
    cold start doesn't pay the connection cost until a request actually needs
    it. DATABASE_URL should be Supabase's transaction-mode POOLER connection
    string (port 6543), always — not just in production. Supabase's direct
    connection (5432) resolves to IPv6 only, which fails outright on networks
    without working IPv6 (confirmed: ENETUNREACH on a real setup); the pooler
    works on IPv4 and also avoids exhausting connection slots when many
    serverless instances each open their own pool. */
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: false },
      // Supabase's cert chain isn't always in Node's default trust store
      // depending on runtime — rejectUnauthorized:false still uses TLS
      // (encrypted), it just skips CA verification. Set DB_VERIFY_SSL=strict
      // and supply DB_CA_CERT if you need full verification.
    });
  }
  return pool;
}

/** Reads the single app_state row. Throws if the schema hasn't been applied
    yet — see sql/schema.sql and scripts/migrate-from-json.js. */
async function loadState() {
  const { rows } = await getPool().query('SELECT data, rev, updated_at FROM app_state WHERE id = 1');
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
  const result = await getPool().query(
    'UPDATE app_state SET data = $1::jsonb, rev = rev + 1, updated_at = now() WHERE id = 1',
    [JSON.stringify(doc)]
  );
  if (result.rowCount !== 1) throw new Error('save failed — app_state row missing');
  const { rows } = await getPool().query('SELECT rev, updated_at FROM app_state WHERE id = 1');
  return { rev: rows[0].rev, updatedAt: rows[0].updated_at };
}

/** Cheap poll target — just the rev, no JSON parse/serialize. */
async function loadRev() {
  const { rows } = await getPool().query('SELECT rev FROM app_state WHERE id = 1');
  if (!rows.length) throw new Error('app_state row missing');
  return rows[0].rev;
}

module.exports = { getPool, loadState, saveState, loadRev };
