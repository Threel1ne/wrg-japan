'use strict';

// Applies sql/schema.sql using the mysql2 package directly — no system
// `mysql` CLI required. Safe to re-run: every statement in schema.sql uses
// CREATE TABLE IF NOT EXISTS, so running this twice is a no-op the second time.
//
// Usage:  node scripts/apply-schema.js

require('../lib/load-env');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

async function main() {
  const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Missing environment variables:', missing.join(', '));
    console.error('Set them in a local .env file (copy .env.example), or export them in your shell first.');
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Split on statement-terminating semicolons, dropping comment-only lines
  // and blank statements. schema.sql is intentionally simple (no stored
  // procedures or semicolons inside string literals), so a plain split is safe.
  const statements = sql
    .split(';')
    .map((s) => s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
    .filter(Boolean);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
    ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: true },
  });

  try {
    for (const stmt of statements) {
      const label = stmt.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/i)?.[1] || stmt.slice(0, 40);
      await conn.query(stmt);
      console.log('applied:', label);
    }
    console.log('\nSchema applied successfully.');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Failed to apply schema:', err.message);
  process.exit(1);
});
