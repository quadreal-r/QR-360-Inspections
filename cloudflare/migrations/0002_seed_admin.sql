-- Seed first admin (Access email)
INSERT INTO users (email, display_name, role, created_by)
VALUES ('robert.piwin@quadreal.com', 'Robert Piwin', 'admin', 'seed')
ON CONFLICT(email) DO UPDATE SET
  role = 'admin',
  display_name = COALESCE(NULLIF(excluded.display_name, ''), users.display_name);
