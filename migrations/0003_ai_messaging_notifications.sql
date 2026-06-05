CREATE TABLE IF NOT EXISTS user_ai_connections (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	provider TEXT NOT NULL,
	encrypted_api_key TEXT NOT NULL,
	base_url TEXT,
	model_name TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_user_ai_connections_user
	ON user_ai_connections(user_id);

CREATE TABLE IF NOT EXISTS user_messaging_connections (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	channel TEXT NOT NULL,
	external_user_id TEXT,
	external_username TEXT,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE(user_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_user_messaging_connections_user
	ON user_messaging_connections(user_id);

CREATE TABLE IF NOT EXISTS telegram_link_codes (
	code TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	expires_at INTEGER NOT NULL,
	used_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_user
	ON telegram_link_codes(user_id);

CREATE TABLE IF NOT EXISTS user_notification_schedules (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	channel TEXT NOT NULL,
	topic TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 0,
	timezone TEXT NOT NULL DEFAULT 'America/New_York',
	times_json TEXT NOT NULL DEFAULT '[]',
	insight_mode TEXT NOT NULL DEFAULT 'smart',
	last_sent_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE(user_id, channel, topic)
);

CREATE INDEX IF NOT EXISTS idx_user_notification_schedules_due
	ON user_notification_schedules(channel, topic, enabled);

CREATE TABLE IF NOT EXISTS user_notification_logs (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	channel TEXT NOT NULL,
	topic TEXT NOT NULL,
	scheduled_for TEXT NOT NULL,
	sent_at TEXT,
	status TEXT NOT NULL,
	error_message TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_user_notification_logs_user
	ON user_notification_logs(user_id, created_at DESC);
