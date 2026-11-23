-- Bridge PCs: a small Windows app watches a folder on each PC and sends new audio files for transcription.

-- One row per PC. Only a SHA-256 hash of the device token is stored.
CREATE TABLE IF NOT EXISTS bridge_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  sheet_json TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  version TEXT,
  watch_folder TEXT,
  queue_size INTEGER NOT NULL DEFAULT 0,
  current_file TEXT,
  last_error TEXT
);

-- One-time pairing codes (hashed). Valid for 15 minutes.
CREATE TABLE IF NOT EXISTS bridge_pairing (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Every file a PC has sent, so nothing is transcribed or written to the sheet twice.
CREATE TABLE IF NOT EXISTS bridge_files (
  device_id TEXT NOT NULL REFERENCES bridge_devices(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  file_day TEXT NOT NULL,
  status TEXT NOT NULL,              -- done | failed
  row_no INTEGER NOT NULL,
  history_id TEXT,
  words INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  sheet_done INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS bridge_files_day ON bridge_files(device_id, file_day);

-- Output style and language for bridge PCs (one row).
CREATE TABLE IF NOT EXISTS bridge_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'smart',
  language TEXT NOT NULL DEFAULT 'Bangla (Bangladesh)'
);
INSERT OR IGNORE INTO bridge_settings (id) VALUES (1);
