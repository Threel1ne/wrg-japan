-- WRG 2026 Japan — Postgres schema (Supabase / Vercel serverless deployment)
--
-- Design: the whole app document (meta, teams, schedule, itinerary, notes,
-- travel, announcements) is kept as ONE JSONB blob, same shape as the old
-- data/db.json file, in a single-row table. This is a deliberate choice over
-- a fully normalized schema: it lets every existing admin form (which reads
-- and writes whole nested objects — a team with its members/matches/
-- checklist, a whole schedule day, etc.) keep working unchanged. If you
-- later want real relational queries (e.g. "list all members across both
-- teams"), migrating to normalized tables is a clean follow-up — this
-- schema doesn't block that, it just isn't required to get the site working.

CREATE TABLE IF NOT EXISTS app_state (
  id INT PRIMARY KEY,
  data JSONB NOT NULL,
  rev INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Login rate limiting. In-memory rate limiting (the old server.js approach)
-- doesn't work across serverless instances — each cold start would reset it,
-- so a brute-force attempt just needs to keep hitting fresh instances. A
-- table makes the limit real regardless of which instance handles a request.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip VARCHAR(64) PRIMARY KEY,
  attempt_count INT NOT NULL DEFAULT 0,
  reset_at TIMESTAMPTZ NOT NULL
);
