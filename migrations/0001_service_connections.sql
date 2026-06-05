CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	github_login TEXT NOT NULL UNIQUE,
	display_name TEXT,
	email TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS service_connections (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	service_id TEXT NOT NULL,
	auth_type TEXT NOT NULL,
	encrypted_credentials TEXT NOT NULL,
	scopes TEXT,
	expires_at INTEGER,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	UNIQUE(user_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_service_connections_user
	ON service_connections(user_id);

CREATE INDEX IF NOT EXISTS idx_service_connections_service
	ON service_connections(service_id);
