-- Silent usage telemetry for daily activity digest email
CREATE TABLE IF NOT EXISTS activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE,
  event_type TEXT NOT NULL,
  tour_key TEXT,
  duration_ms INTEGER,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_events_created ON activity_events(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_events_email_created ON activity_events(email, created_at);

CREATE TABLE IF NOT EXISTS activity_report_sent (
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ok INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (period_start, period_end)
);
