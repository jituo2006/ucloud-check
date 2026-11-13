CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  attendance_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  outcome TEXT,
  claimed_at INTEGER,
  notified INTEGER NOT NULL DEFAULT 0,
  notify_at INTEGER NOT NULL DEFAULT 0,
  result_notified INTEGER NOT NULL DEFAULT 0,
  result_notify_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_status ON events(status, expires_at);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
