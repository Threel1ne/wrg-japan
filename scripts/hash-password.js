'use strict';

// Generates ADMIN_SALT / ADMIN_HASH for a password you choose — set both as
// Vercel environment variables. The plaintext password is never stored
// anywhere; only this salt+hash pair (and the password itself, which only
// you know) can produce a matching login.
//
// Usage:  node scripts/hash-password.js "your new password"

const crypto = require('node:crypto');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js "your new password"');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');

console.log('\nAdd these to your Vercel project — Settings → Environment Variables:\n');
console.log('ADMIN_SALT=' + salt);
console.log('ADMIN_HASH=' + hash);
console.log('\nAlso generate a SESSION_SECRET (any long random string), for example:');
console.log('SESSION_SECRET=' + crypto.randomBytes(32).toString('hex'));
console.log('\nThe password itself is not saved anywhere — remember it.\n');
