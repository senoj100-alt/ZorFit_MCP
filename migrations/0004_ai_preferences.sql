CREATE TABLE IF NOT EXISTS user_ai_preferences (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	default_provider TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
