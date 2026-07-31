-- Per-member View/Edit within a group (caps access via group tour grants).
-- Existing members default to edit so prior full group-grant behavior is preserved.
ALTER TABLE group_members ADD COLUMN permission TEXT NOT NULL DEFAULT 'edit';
