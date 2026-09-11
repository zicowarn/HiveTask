-- Sync metadata k/v store. Keys are "synced:<kind>:<state>" (kind:
-- "issues"|"pulls") stamped by the refresh commands after a successful
-- gh roundtrip; value is an RFC3339 UTC timestamp. This is the ground
-- truth for the status bar's "last updated" cell and the future
-- background-sync staleness check.
CREATE TABLE IF NOT EXISTS meta (
    key       TEXT PRIMARY KEY,
    value     TEXT NOT NULL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
