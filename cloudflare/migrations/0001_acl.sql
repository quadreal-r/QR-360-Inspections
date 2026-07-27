-- INSP 360 ACL: users, groups, memberships, per-tour grants
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')) DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (group_id, email)
);

CREATE INDEX IF NOT EXISTS idx_group_members_email ON group_members(email);

CREATE TABLE IF NOT EXISTS project_grants (
  cloud_key TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  PRIMARY KEY (cloud_key, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_project_grants_principal ON project_grants(principal_type, principal_id);
CREATE INDEX IF NOT EXISTS idx_project_grants_key ON project_grants(cloud_key);
