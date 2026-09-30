'use strict';

// Node's raw network errors (ENOTFOUND/ECONNREFUSED/ETIMEDOUT) often leave
// .message empty, and Postgres's own errors use SQLSTATE codes rather than
// readable names — this surfaces every field that might actually explain
// what went wrong, plus a plain-language guess for the common cases.
// Codes verified against a real Postgres instance, not guessed:
// 28P01 (wrong password), 3D000 (unknown database), ECONNREFUSED, ETIMEDOUT.

const HINTS = {
  ENOTFOUND: 'DNS lookup failed — the hostname in DATABASE_URL doesn\'t resolve. Double-check it; a database admin-panel URL (e.g. one starting "pma.", or any web-based DB manager) is a web page, not necessarily the database server\'s own address.',
  ECONNREFUSED: 'Connection refused — nothing is listening on that host:port combination. The database may only accept connections on a different port, or from specific IPs (many hosts whitelist by IP).',
  ETIMEDOUT: 'No response at all from that host:port — three common causes: (1) the hostname in DATABASE_URL doesn\'t actually resolve to a reachable database server (this can also happen behind carrier-grade NAT / CGNAT on home internet, where the "public" IP is shared and inbound traffic never reaches you), (2) a firewall or security group is silently dropping the connection, or (3) the port is wrong.',
  '28P01': 'Wrong password for that database user (Postgres SQLSTATE 28P01 — password authentication failed).',
  '28000': 'Not authorized to connect as this user from this host (Postgres SQLSTATE 28000 — invalid_authorization_specification). Some hosts restrict which IPs a user may connect from.',
  '3D000': 'That database name doesn\'t exist on this server (Postgres SQLSTATE 3D000 — check the database name at the end of DATABASE_URL).',
};

function describeDbError(err) {
  const lines = [
    `message : ${err.message || '(empty)'}`,
    `code    : ${err.code || '(none)'}`,
    `errno   : ${err.errno ?? '(none)'}`,
  ];
  if (err.address) lines.push(`address : ${err.address}:${err.port || ''}`);

  const hint = HINTS[err.code];
  if (hint) lines.push(`\nlikely cause: ${hint}`);

  return lines.join('\n');
}

module.exports = { describeDbError };
