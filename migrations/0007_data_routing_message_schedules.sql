CREATE TABLE IF NOT EXISTS user_data_preferences (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	category TEXT NOT NULL,
	provider TEXT NOT NULL,
	fallback_provider TEXT,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE(user_id, category)
);

CREATE INDEX IF NOT EXISTS idx_user_data_preferences_user
	ON user_data_preferences(user_id);

CREATE TABLE IF NOT EXISTS user_message_schedules (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	channel TEXT NOT NULL,
	title TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 0,
	timezone TEXT NOT NULL DEFAULT 'America/New_York',
	times_json TEXT NOT NULL DEFAULT '[]',
	insight_mode TEXT NOT NULL DEFAULT 'smart',
	categories_json TEXT NOT NULL DEFAULT '["nutrition"]',
	question TEXT,
	prompt_instructions TEXT,
	last_sent_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_user_message_schedules_due
	ON user_message_schedules(channel, enabled);

CREATE INDEX IF NOT EXISTS idx_user_message_schedules_user
	ON user_message_schedules(user_id, created_at ASC);
