-- Notion export of the nightly Drive automation can be switched on or off. Off by default (Sheets only).
ALTER TABLE drive_connection ADD COLUMN notion_enabled INTEGER NOT NULL DEFAULT 0;
