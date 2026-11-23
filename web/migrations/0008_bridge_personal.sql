-- A PC can belong to the team (a named PC with a sheet tab) or to one person who signed in with Google.
ALTER TABLE bridge_devices ADD COLUMN kind TEXT NOT NULL DEFAULT 'team';      -- team | personal
-- Personal PCs choose their own output style and language (team PCs use the shared bridge_settings).
ALTER TABLE bridge_devices ADD COLUMN mode TEXT;
ALTER TABLE bridge_devices ADD COLUMN language TEXT;
-- Team PCs: also add the transcripts to the team Google Sheet (on by default).
ALTER TABLE bridge_devices ADD COLUMN sheet_enabled INTEGER NOT NULL DEFAULT 1;

-- "Sign in with Google" from the app: the app waits while the person approves it on the website.
CREATE TABLE IF NOT EXISTS bridge_login (
  id_hash TEXT PRIMARY KEY,          -- hash of the secret only the app knows
  user_code TEXT NOT NULL UNIQUE,    -- shown in the app and on the approval page
  name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE
);
