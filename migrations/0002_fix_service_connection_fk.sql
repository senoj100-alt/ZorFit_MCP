-- Repair older databases where service_connections.user_id referenced users.github_login.
-- The application stores user IDs as stable values like "github:<login>", so the
-- foreign key must point at users.id.

PRAGMA foreign_keys = off;

CREATE TABLE IF NOT EXISTS service_connections_new (
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

INSERT OR IGNORE INTO service_connections_new (
  id,
  user_id,
  service_id,
  auth_type,
  encrypted_credentials,
  scopes,
  expires_at,
  created_at,
  updated_at
)
SELECT
  id,
  user_id,
  service_id,
  auth_type,
  encrypted_credentials,
  scopes,
  expires_at,
  created_at,
  updated_at
FROM service_connections;

DROP TABLE service_connections;
ALTER TABLE service_connections_new RENAME TO service_connections;

CREATE INDEX IF NOT EXISTS idx_service_connections_user
  ON service_connections(user_id);

CREATE INDEX IF NOT EXISTS idx_service_connections_service
  ON service_connections(service_id);

PRAGMA foreign_keys = on;
