-- Rate limit /api/auth/request-code: per-email cooldown + hourly cap
ALTER TABLE auth_otps ADD COLUMN request_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE auth_otps ADD COLUMN window_started_at TEXT;
