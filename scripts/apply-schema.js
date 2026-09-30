'use strict';

// Applies sql/schema.sql using the pg package directly — no system `psql`
// CLI required. Safe to re-run: every statement in schema.sql uses
// CREATE TABLE IF NOT EXISTS, so running this twice is a no-op the second time.
//
// Usage:  node scripts/apply-schema.js

require('../lib/load-env');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { describeDbError } = require('../lib/describe-db-error');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL.');
    console.error('Set it in a local .env file (copy .env.example), or export it in your shell first.');
    process.exit(1);
  }

  const sqlPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Split on statement-terminating semicolons, dropping comment-only lines
  // and blank statements. schema.sql is intentionally simple (no functions
  // or semicolons inside string literals), so a plain split is safe.
  const statements = sql
    .split(';')
    .map((s) => s.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
    .filter(Boolean);

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    for (const stmt of statements) {
      const label = stmt.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/i)?.[1] || stmt.slice(0, 40);
      await client.query(stmt);
      console.log('applied:', label);
    }
    console.log('\nSchema applied successfully.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Failed to apply schema.\n');
  console.error(describeDbError(err));
  process.exit(1);
});
