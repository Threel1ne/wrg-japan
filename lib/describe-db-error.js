'use strict';

// mysql2 connection errors often carry the useful info in .code/.errno rather
// than a populated .message — printing only err.message (like a plain Error)
// can come out blank. This surfaces every field that might actually explain
// what went wrong, plus a plain-language guess for the common cases.

const HINTS = {
  ENOTFOUND: 'DNS lookup failed — DB_HOST doesn\'t resolve. Double-check the hostname; a phpMyAdmin URL (often starting "pma.") is a web page, not necessarily the database server\'s own address.',
  ECONNREFUSED: 'Connection refused — nothing is listening on that host:port combination. The database may only accept connections on a different port, or from specific IPs (many hosts whitelist by IP).',
  ETIMEDOUT: 'No response at all from that host:port — three common causes: (1) DB_HOST doesn\'t actually resolve to a real database server (a phpMyAdmin URL, often starting "pma.", is a web page for managing MySQL, not the database server\'s own hostname — ask your host for the separate DB hostname/port), (2) a firewall is silently dropping the connection because your IP isn\'t allowed, or (3) the port is wrong.',
  ER_ACCESS_DENIED_ERROR: 'Access denied — DB_USER / DB_PASSWORD is wrong, or that user isn\'t allowed to connect from this machine\'s IP.',
  ER_BAD_DB_ERROR: 'Unknown database — DB_NAME doesn\'t exist on that server, or this user can\'t see it.',
  HANDSHAKE_SSL_ERROR: 'TLS handshake failed — the server may not support TLS the way this client expects. Try setting DB_SSL=false in .env if this is a database that doesn\'t use TLS.',
  PROTOCOL_CONNECTION_LOST: 'The server closed the connection during login — usually means DB_PASSWORD is wrong, but can also happen when the server needs TLS (try removing DB_SSL=false from .env) or, less commonly, when it needs DB_SSL=false because it doesn\'t support TLS at all. Try toggling DB_SSL if the password is definitely correct.',
};

function describeDbError(err) {
  const lines = [
    `message : ${err.message || '(empty)'}`,
    `code    : ${err.code || '(none)'}`,
    `errno   : ${err.errno ?? '(none)'}`,
  ];
  if (err.sqlState) lines.push(`sqlState: ${err.sqlState}`);
  if (err.sqlMessage) lines.push(`sqlMessage: ${err.sqlMessage}`);
  if (err.address) lines.push(`address : ${err.address}:${err.port || ''}`);

  const hint = HINTS[err.code];
  if (hint) lines.push(`\nlikely cause: ${hint}`);

  return lines.join('\n');
}

module.exports = { describeDbError };
