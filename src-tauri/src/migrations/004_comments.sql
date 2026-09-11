-- Cached conversation comments for issues and PRs.
--
-- Rebuilds the QHiveTask-era comments table (issue_number/pull_number
-- columns with parent FKs). The table holds refetchable cache data only,
-- so dropping it loses nothing; the kind-keyed shape covers both entity
-- types without FK coupling to whatever happens to be cached. Rows are
-- replaced wholesale whenever that entity's comments are re-synced.
DROP TABLE IF EXISTS comments;

CREATE TABLE comments (
    kind       TEXT NOT NULL,              -- "issue" | "pull"
    number     INTEGER NOT NULL,
    author     TEXT,
    body       TEXT,
    created_at TEXT,
    synced_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_comments_entity ON comments (kind, number, created_at);
