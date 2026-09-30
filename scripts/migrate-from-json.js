'use strict';

// One-time import: loads a JSON file (same shape as the old data/db.json)
// into the app_state table. Safe to re-run — it replaces the row rather than
// erroring on a duplicate, so you can use this both for the first setup and
// to reset a test database back to a known state.
//
// Usage:  node scripts/migrate-from-json.js path/to/db.json
// Reads DB connection info from .env locally, or real env vars in the shell.

require('../lib/load-env');
const fs = require('node:fs');
const mysql = require('mysql2/promise');
const { describeDbError } = require('../lib/describe-db-error');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/migrate-from-json.js path/to/db.json');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error('File not found:', file);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { rev, updatedAt, ...doc } = raw; // rev/updatedAt live in their own columns, not the JSON blob

  const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Missing environment variables:', missing.join(', '));
    console.error('Set them in a local .env file, or export them in your shell first.');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: true },
  });

  try {
    await conn.query(
      'INSERT INTO app_state (id, data, rev) VALUES (1, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE data = VALUES(data), rev = VALUES(rev)',
      [JSON.stringify(doc), typeof rev === 'number' ? rev : 1]
    );
    console.log(`Imported ${file} into app_state (rev ${typeof rev === 'number' ? rev : 1}).`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Migration failed.\n');
  console.error(describeDbError(err));
  process.exit(1);
});
