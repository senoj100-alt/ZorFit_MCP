ALTER TABLE user_notification_logs ADD COLUMN schedule_id TEXT;
ALTER TABLE user_notification_logs ADD COLUMN message_title TEXT;
ALTER TABLE user_notification_logs ADD COLUMN message_summary TEXT;
ALTER TABLE user_notification_logs ADD COLUMN message_text TEXT;

CREATE INDEX IF NOT EXISTS idx_user_notification_logs_schedule
	ON user_notification_logs(user_id, schedule_id, scheduled_for);

CREATE TABLE IF NOT EXISTS user_score_preferences (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	nutrition_weight INTEGER NOT NULL DEFAULT 35,
	readiness_weight INTEGER NOT NULL DEFAULT 35,
	fitness_weight INTEGER NOT NULL DEFAULT 30,
	protein_target_g INTEGER NOT NULL DEFAULT 100,
	sugar_limit_g INTEGER NOT NULL DEFAULT 25,
	fiber_target_g INTEGER NOT NULL DEFAULT 25,
	sleep_target_hours REAL NOT NULL DEFAULT 7.0,
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
