-- Google Drive folder batches. One row per batch: written when it starts and when it ends.
-- Live progress is kept in the BatchRunner Durable Object, not here, to keep D1 usage low.
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  folder_url TEXT NOT NULL,
  mode TEXT NOT NULL,
  language TEXT NOT NULL,
  total INTEGER NOT NULL,
  done_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,               -- running | done | cancelled
  notion_url TEXT,
  sheet_url TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS batches_user_created ON batches(user_id, created_at DESC);

-- Transcripts made by a batch point back to it.
ALTER TABLE transcriptions ADD COLUMN batch_id TEXT;
