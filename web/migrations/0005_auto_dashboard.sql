-- Dashboard numbers per computer: how many recordings Drive holds and how the last scan went.
ALTER TABLE drive_computers ADD COLUMN total_files INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drive_computers ADD COLUMN last_scan_at INTEGER;
ALTER TABLE drive_computers ADD COLUMN scan_error TEXT;
