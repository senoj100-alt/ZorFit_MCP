ALTER TABLE user_ai_connections
	ADD COLUMN request_settings_json TEXT NOT NULL DEFAULT '{}';
