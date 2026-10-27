-- Apply before deploying the Worker with conversation locking enabled.
-- Existing notes, messages, and attachments are not changed.
CREATE TABLE IF NOT EXISTS conversation_locks (
  owner_username TEXT PRIMARY KEY,
  salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  version TEXT NOT NULL,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);
