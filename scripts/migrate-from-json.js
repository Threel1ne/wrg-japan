'use strict';

// One-time import: loads a JSON file (same shape as the old data/db.json)
// into the app_state table. Safe to re-run — it replaces the row rather than
// erroring on a duplicate, so you can use this both for the first setup and
// to reset a test database back to a known state.
//
// Usage:  node scripts/migrate-from-json.js path/to/db.json
// Reads DATABASE_URL from .env locally, or a real env var in the shell.

require('../lib/load-env');
const fs = require('node:fs');
const { Client } = require('pg');
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

  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL.');
    console.error('Set it in a local .env file, or export it in your shell first.');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'false' ? undefined : { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await client.query(
      'INSERT INTO app_state (id, data, rev) VALUES (1, $1::jsonb, $2) ' +
      'ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, rev = EXCLUDED.rev',
      [JSON.stringify(doc), typeof rev === 'number' ? rev : 1]
    );
    console.log(`Imported ${file} into app_state (rev ${typeof rev === 'number' ? rev : 1}).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed.\n');
  console.error(describeDbError(err));
  process.exit(1);
});
