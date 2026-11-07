-- Local SQLite stand-in for D1. See docs/architecture.md before Worker migration.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS demo_sessions (
 id TEXT PRIMARY KEY, csrf TEXT NOT NULL, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, state_json TEXT NOT NULL CHECK (json_valid(state_json))
);
CREATE TABLE IF NOT EXISTS audit_events (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES demo_sessions(id),
 at TEXT NOT NULL, type TEXT NOT NULL, order_id TEXT NOT NULL, detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_by_session ON audit_events(session_id, at);
