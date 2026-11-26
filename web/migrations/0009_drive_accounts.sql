-- Several Google Drive accounts can be watched. Each has its own settings and its own spreadsheet.
-- The old single-row drive_connection table is kept as it is (nothing is dropped); its row is copied
-- into drive_accounts as the account "primary".
CREATE TABLE IF NOT EXISTS drive_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  google_email TEXT NOT NULL UNIQUE,
  refresh_token TEXT NOT NULL,
  app_url TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'smart',
  language TEXT NOT NULL DEFAULT 'Bangla (Bangladesh)',
  enabled INTEGER NOT NULL DEFAULT 1,
  notion_enabled INTEGER NOT NULL DEFAULT 0,
  -- Link or id of this account's own spreadsheet (empty: the team spreadsheet from SHEETS_SPREADSHEET_ID).
  spreadsheet TEXT,
  -- Extra folder ids (comma or space separated) to scan besides the top level of My Drive and Computers.
  extra_folders TEXT,
  connected_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO drive_accounts (id, user_id, google_email, refresh_token, app_url, mode, language, enabled, notion_enabled, connected_at)
  SELECT 'primary', user_id, google_email, refresh_token, app_url, mode, language, enabled, notion_enabled, connected_at
    FROM drive_connection WHERE id = 1;

ALTER TABLE drive_computers ADD COLUMN account_id TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE drive_jobs ADD COLUMN account_id TEXT NOT NULL DEFAULT 'primary';
CREATE INDEX IF NOT EXISTS drive_computers_account ON drive_computers(account_id);
CREATE INDEX IF NOT EXISTS drive_jobs_account ON drive_jobs(account_id);
