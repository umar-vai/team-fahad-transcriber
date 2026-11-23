-- Link a new PC to a computer that already has a sheet tab (Drive "Computers" or an earlier bridge PC).

-- Team PIN typed on a fresh PC before it may see the list of computers. Only a salted hash is stored.
ALTER TABLE bridge_settings ADD COLUMN link_pin_hash TEXT;
-- The person who set the PIN: history rows of linked PCs belong to them.
ALTER TABLE bridge_settings ADD COLUMN link_user_id TEXT;
ALTER TABLE bridge_settings ADD COLUMN link_fail_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bridge_settings ADD COLUMN link_locked_until INTEGER NOT NULL DEFAULT 0;

-- The Drive computer (drive_computers.folder_id) whose sheet tab this PC took over.
ALTER TABLE bridge_devices ADD COLUMN linked_computer_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS bridge_devices_computer ON bridge_devices(linked_computer_id) WHERE linked_computer_id IS NOT NULL;
