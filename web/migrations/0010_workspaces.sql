-- Teams (workspaces). The Auto page belongs to a team: its Drive accounts, Bridge PCs, jobs and
-- transcripts are only visible to that team's members. Admins (ADMIN_EMAILS) manage every team.
-- kind: team = an in-house team (Team Fahad, Sukun Life); customer = a paying outside customer.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'team',
  -- 1 for the original team: it may use the shared team spreadsheet (SHEETS_SPREADSHEET_ID) and Notion.
  is_default INTEGER NOT NULL DEFAULT 0,
  -- Features this team gets on the Auto page.
  feature_drive INTEGER NOT NULL DEFAULT 1,
  feature_bridge INTEGER NOT NULL DEFAULT 1,
  -- The team's own spreadsheet (link or id). Empty: the shared team spreadsheet (default team only).
  spreadsheet TEXT,
  -- Bridge PC settings of this team (were the single row of bridge_settings).
  bridge_mode TEXT NOT NULL DEFAULT 'smart',
  bridge_language TEXT NOT NULL DEFAULT 'Bangla (Bangladesh)',
  link_pin_hash TEXT,
  link_user_id TEXT,
  created_at INTEGER NOT NULL
);

-- Who may open a team's Auto page. Keyed by email so people can be added before they first sign in.
-- role: manager = can change settings, connect Drive, pair PCs; viewer = sees the dashboard and transcripts.
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  added_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, email)
);
CREATE INDEX IF NOT EXISTS workspace_members_email ON workspace_members(email);

-- Everything that existed so far belongs to the original team.
INSERT OR IGNORE INTO workspaces (id, name, kind, is_default, bridge_mode, bridge_language, link_pin_hash, link_user_id, created_at)
  SELECT 'team-fahad', 'Team Fahad', 'team', 1, mode, language, link_pin_hash, link_user_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM bridge_settings WHERE id = 1;
INSERT OR IGNORE INTO workspaces (id, name, kind, is_default, created_at)
  VALUES ('team-fahad', 'Team Fahad', 'team', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);

ALTER TABLE drive_accounts ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'team-fahad';
ALTER TABLE drive_jobs ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'team-fahad';
ALTER TABLE bridge_devices ADD COLUMN workspace_id TEXT;
ALTER TABLE bridge_pairing ADD COLUMN workspace_id TEXT;
ALTER TABLE batches ADD COLUMN workspace_id TEXT;
ALTER TABLE transcriptions ADD COLUMN workspace_id TEXT;
CREATE INDEX IF NOT EXISTS drive_accounts_workspace ON drive_accounts(workspace_id);
CREATE INDEX IF NOT EXISTS drive_jobs_workspace ON drive_jobs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bridge_devices_workspace ON bridge_devices(workspace_id);
CREATE INDEX IF NOT EXISTS batches_workspace ON batches(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transcriptions_workspace ON transcriptions(workspace_id, created_at DESC);

-- Team PCs belong to the team; personal PCs stay personal.
UPDATE bridge_devices SET workspace_id = 'team-fahad' WHERE kind = 'team';

-- Nightly Drive batches belong to the team, and so do their transcripts.
UPDATE batches SET workspace_id = 'team-fahad' WHERE id IN (SELECT batch_id FROM drive_jobs WHERE batch_id IS NOT NULL);
UPDATE transcriptions SET workspace_id = 'team-fahad'
  WHERE batch_id IS NOT NULL AND batch_id IN (SELECT id FROM batches WHERE workspace_id = 'team-fahad');

-- Transcripts made by team Bridge PCs (history id "bridge-<device id>-<fingerprint>") belong to the team.
UPDATE transcriptions SET workspace_id = 'team-fahad'
  WHERE source_type = 'bridge' AND workspace_id IS NULL AND id IN (
    SELECT t.id FROM transcriptions t JOIN bridge_devices d ON t.id LIKE 'bridge-' || d.id || '-%' WHERE d.kind = 'team'
  );
