-- Users who signed in with Google.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  picture TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

-- Login sessions. Only a SHA-256 hash of the cookie token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- One row per finished transcription.
CREATE TABLE IF NOT EXISTS transcriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,          -- upload | link | youtube | live
  source_ref TEXT,                    -- file name or URL
  mode TEXT NOT NULL,
  language TEXT NOT NULL,
  duration REAL,
  transcript TEXT NOT NULL,
  segments_json TEXT,                 -- [{start,end,text,speaker}]
  extras_json TEXT,                   -- summary, translations, etc.
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transcriptions_user_created ON transcriptions(user_id, created_at DESC);
