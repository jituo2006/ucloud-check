CREATE TABLE IF NOT EXISTS attendance_verifications (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  started_at INTEGER,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER,
  deadline_at INTEGER NOT NULL,
  checked_at INTEGER,
  record_status INTEGER,
  record_time TEXT
);
CREATE INDEX IF NOT EXISTS attendance_verifications_due ON attendance_verifications(state, next_at);
