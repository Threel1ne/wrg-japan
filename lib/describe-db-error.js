'use strict';

// Node's raw network errors (ENOTFOUND/ECONNREFUSED/ETIMEDOUT) often leave
// .message empty, and Postgres's own errors use SQLSTATE codes rather than
// readable names — this surfaces every field that might actually explain
// what went wrong, plus a plain-language guess for the common cases.
// Codes verified against real failures, not guessed:
// 28P01 (wrong password) and 3D000 (unknown database) from a real Postgres
// instance; ENETUNREACH from an actual user hitting Supabase's IPv6-only
// direct-connection hostname on a network without IPv6.

const HINTS = {
  ENOTFOUND: 'DNS lookup failed — the hostname in DATABASE_URL doesn\'t resolve. Double-check it; a database admin-panel URL (e.g. one starting "pma.", or any web-based DB manager) is a web page, not necessarily the database server\'s own address.',
  ECONNREFUSED: 'Connection refused — nothing is listening on that host:port combination. The database may only accept connections on a different port, or from specific IPs (many hosts whitelist by IP).',
  ENETUNREACH: 'Can\'t route to that address at all — check whether it\'s an IPv6 address (look for colons, like "2406:..." in the address above). Supabase\'s "Direct connection" hostname resolves to IPv6 only; if your network doesn\'t have working IPv6 (common on home/office connections), it fails exactly like this. Use the "Transaction pooler" connection string instead (port 6543) — it works on IPv4.',
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
