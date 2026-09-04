CREATE TABLE IF NOT EXISTS email_outbox (
  request_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox(status, next_attempt_at);
