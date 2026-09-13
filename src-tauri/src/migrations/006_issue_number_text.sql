-- Issue numbers become TEXT (schema v6).
--
-- Gitee v5 issue numbers are strings ("IKCTH7") while GitHub/Gitea stay
-- numeric-looking; the cache key must hold both. Rebuilds issues and
-- comments with TEXT keys, casting legacy INTEGER values losslessly
-- (42 -> '42'). The unused FTS5 external-content table used issue numbers
-- as rowids (INTEGER-only) and no code ever queried it — dropped instead
-- of rebuilt.

DROP TRIGGER IF EXISTS issues_fts_insert;
DROP TRIGGER IF EXISTS issues_fts_delete;
DROP TRIGGER IF EXISTS issues_fts_update;
DROP TABLE IF EXISTS issues_fts;

CREATE TABLE issues_new (
    number      TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'OPEN',
    body        TEXT,
    author      TEXT,
    milestone   TEXT,
    labels      TEXT,
    assignees   TEXT,
    created_at  TEXT,
    updated_at  TEXT,
    url         TEXT,
    data_source TEXT NOT NULL DEFAULT 'github',
    synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO issues_new
SELECT CAST(number AS TEXT), title, state, body, author, milestone, labels,
       assignees, created_at, updated_at, url, data_source, synced_at
FROM issues;
DROP TABLE issues;
ALTER TABLE issues_new RENAME TO issues;

CREATE INDEX IF NOT EXISTS idx_issues_state       ON issues(state);
CREATE INDEX IF NOT EXISTS idx_issues_author      ON issues(author);
CREATE INDEX IF NOT EXISTS idx_issues_milestone   ON issues(milestone);
CREATE INDEX IF NOT EXISTS idx_issues_data_source ON issues(data_source);
CREATE INDEX IF NOT EXISTS idx_issues_updated_at  ON issues(updated_at);

CREATE TABLE comments_new (
    kind       TEXT NOT NULL,              -- "issue" | "pull"
    number     TEXT NOT NULL,              -- issue: platform id as-is; pull: decimal text
    author     TEXT,
    body       TEXT,
    created_at TEXT,
    synced_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO comments_new
SELECT kind, CAST(number AS TEXT), author, body, created_at, synced_at
FROM comments;
DROP TABLE comments;
ALTER TABLE comments_new RENAME TO comments;
CREATE INDEX idx_comments_entity ON comments (kind, number, created_at);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (6, 'Issue numbers as TEXT (Gitee v5 string ids); drop unused FTS5');
