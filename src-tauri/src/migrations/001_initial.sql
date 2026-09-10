-- HiveTask: Initial schema (v1)
-- Creates all core tables for issues, pulls, comments, boards, and FTS5 search.

-- ======================================================================
-- Schema version tracking
-- ======================================================================
CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT
);

-- ======================================================================
-- Issues
-- ======================================================================
CREATE TABLE IF NOT EXISTS issues (
    number      INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'OPEN',
    body        TEXT,
    author      TEXT,
    milestone   TEXT,
    labels      TEXT,        -- JSON array: ["bug","enhancement"]
    assignees   TEXT,        -- JSON array: ["user1","user2"]
    created_at  TEXT,
    updated_at  TEXT,
    url         TEXT,
    data_source TEXT NOT NULL DEFAULT 'github',
    synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issues_state      ON issues(state);
CREATE INDEX IF NOT EXISTS idx_issues_author     ON issues(author);
CREATE INDEX IF NOT EXISTS idx_issues_milestone  ON issues(milestone);
CREATE INDEX IF NOT EXISTS idx_issues_data_source ON issues(data_source);
CREATE INDEX IF NOT EXISTS idx_issues_updated_at ON issues(updated_at);

-- ======================================================================
-- Pull Requests
-- ======================================================================
CREATE TABLE IF NOT EXISTS pulls (
    number      INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'OPEN',
    body        TEXT,
    author      TEXT,
    head_ref    TEXT,
    base_ref    TEXT,
    labels      TEXT,        -- JSON array
    assignees   TEXT,        -- JSON array
    reviewers   TEXT,        -- JSON array
    review_decision TEXT,    -- JSON array: ["APPROVED",...]
    additions   INTEGER DEFAULT 0,
    deletions   INTEGER DEFAULT 0,
    commits     INTEGER DEFAULT 0,
    comments    INTEGER DEFAULT 0,
    created_at  TEXT,
    updated_at  TEXT,
    url         TEXT,
    data_source TEXT NOT NULL DEFAULT 'github',
    synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pulls_state       ON pulls(state);
CREATE INDEX IF NOT EXISTS idx_pulls_author      ON pulls(author);
CREATE INDEX IF NOT EXISTS idx_pulls_base_ref    ON pulls(base_ref);

-- ======================================================================
-- Comments
-- ======================================================================
CREATE TABLE IF NOT EXISTS comments (
    id           INTEGER PRIMARY KEY,
    issue_number INTEGER NOT NULL,
    pull_number  INTEGER,
    body         TEXT,
    author       TEXT,
    is_minimized INTEGER DEFAULT 0,
    created_at   TEXT,
    updated_at   TEXT,
    data_source  TEXT NOT NULL DEFAULT 'github',
    FOREIGN KEY (issue_number) REFERENCES issues(number) ON DELETE CASCADE,
    FOREIGN KEY (pull_number)  REFERENCES pulls(number) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_number);
CREATE INDEX IF NOT EXISTS idx_comments_pull  ON comments(pull_number);

-- ======================================================================
-- Boards (GitHub Projects V2)
-- ======================================================================
CREATE TABLE IF NOT EXISTS boards (
    id          INTEGER PRIMARY KEY,
    title       TEXT NOT NULL,
    state       TEXT DEFAULT 'OPEN',
    data_source TEXT NOT NULL DEFAULT 'github',
    synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS board_columns (
    id          INTEGER PRIMARY KEY,
    board_id    INTEGER NOT NULL,
    name        TEXT NOT NULL,
    position    INTEGER DEFAULT 0,
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_board_columns_board ON board_columns(board_id);

CREATE TABLE IF NOT EXISTS board_items (
    id           INTEGER PRIMARY KEY,
    board_id     INTEGER NOT NULL,
    column_id    INTEGER,
    column_name  TEXT,
    title        TEXT,
    issue_number INTEGER,
    pr_number    INTEGER,
    state        TEXT,
    labels       TEXT,      -- JSON array
    assignee     TEXT,
    data_source  TEXT NOT NULL DEFAULT 'github',
    FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_board_items_board   ON board_items(board_id);
CREATE INDEX IF NOT EXISTS idx_board_items_column  ON board_items(column_id);

-- ======================================================================
-- Full-text search (FTS5)
-- ======================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
    title,
    body,
    labels,
    content='issues',
    content_rowid='number',
    tokenize='unicode61'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS issues_fts_insert AFTER INSERT ON issues BEGIN
    INSERT INTO issues_fts(rowid, title, body, labels)
    VALUES (new.number, new.title, new.body, new.labels);
END;

CREATE TRIGGER IF NOT EXISTS issues_fts_delete AFTER DELETE ON issues BEGIN
    INSERT INTO issues_fts(issues_fts, rowid, title, body, labels)
    VALUES ('delete', old.number, old.title, old.body, old.labels);
END;

CREATE TRIGGER IF NOT EXISTS issues_fts_update AFTER UPDATE ON issues BEGIN
    INSERT INTO issues_fts(issues_fts, rowid, title, body, labels)
    VALUES ('delete', old.number, old.title, old.body, old.labels);
    INSERT INTO issues_fts(rowid, title, body, labels)
    VALUES (new.number, new.title, new.body, new.labels);
END;

-- Record schema version
INSERT OR IGNORE INTO schema_version (version, description)
VALUES (1, 'Initial schema: issues, pulls, comments, boards, FTS5');
