-- Nightly automatic transcription of the Google Drive "Computers" folders.

-- The Google account whose Drive is watched. One row; holds the offline refresh token.
CREATE TABLE IF NOT EXISTS drive_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_email TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  app_url TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'smart',
  language TEXT NOT NULL DEFAULT 'Bangla (Bangladesh)',
  enabled INTEGER NOT NULL DEFAULT 1,
  connected_at INTEGER NOT NULL
);

-- One row per computer folder. Its Notion page and Sheets tab are created once and reused every day.
CREATE TABLE IF NOT EXISTS drive_computers (
  folder_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  notion_json TEXT,
  sheet_json TEXT,
  created_at INTEGER NOT NULL
);

-- Every media file ever picked up, so nothing is transcribed twice.
CREATE TABLE IF NOT EXISTS drive_files (
  file_id TEXT PRIMARY KEY,
  computer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  file_day TEXT NOT NULL,
  job_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drive_files_job ON drive_files(job_id);

-- One job per computer per night. Waits in "queued" until a slot is free.
CREATE TABLE IF NOT EXISTS drive_jobs (
  id TEXT PRIMARY KEY,
  computer_id TEXT NOT NULL,
  computer_name TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL,              -- queued | running | done
  files_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS drive_jobs_status ON drive_jobs(status, created_at);
