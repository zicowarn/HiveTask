-- Migration 002: Project tables — custom fields and kanban boards
--
-- Key design: Project = container with dynamic field definitions.
-- Items = Issues with attached field values (stored as JSON).
-- This supports GitHub Projects V2 (dynamic per-project fields) and
-- will be the foundation for local standalone tasks.
--
-- NOTE: Do NOT wrap in BEGIN TRANSACTION / COMMIT — runSql() already
-- wraps all statements in a transaction. The splitSqlStatements()
-- parser treats "BEGIN" as a trigger block start, which would prevent
-- splitting and cause the entire file to be sent as one statement.

-- Projects (kanban boards / field collections)
CREATE TABLE IF NOT EXISTS project_definitions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',
    data_source TEXT    NOT NULL DEFAULT 'github',  -- "github" | "local"
    source_id   TEXT    NOT NULL DEFAULT '',         -- GH project node ID
    columns     TEXT    NOT NULL DEFAULT '[]',       -- JSON array: ["Backlog","Todo",...]
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Custom field definitions (per project, dynamic schema)
CREATE TABLE IF NOT EXISTS project_fields (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES project_definitions(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL DEFAULT '',
    field_type  INTEGER NOT NULL DEFAULT 0,  -- 0=SELECT, 1=NUMBER, 2=DATE, 3=TEXT, 4=ITERATION
    options     TEXT    NOT NULL DEFAULT '[]', -- JSON array for SINGLE_SELECT
    position    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_project_fields_project ON project_fields(project_id);

-- Project items (cards = issues with field values)
CREATE TABLE IF NOT EXISTS project_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES project_definitions(id) ON DELETE CASCADE,
    issue_number  INTEGER NOT NULL,  -- References issues(number)
    issue_title   TEXT    NOT NULL DEFAULT '',
    issue_state   TEXT    NOT NULL DEFAULT 'OPEN',
    field_values  TEXT    NOT NULL DEFAULT '{}',  -- JSON: {"Type":"Task","Size":3}
    status        TEXT    NOT NULL DEFAULT 'Todo',  -- Kanban column name
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_items_project ON project_items(project_id);
CREATE INDEX IF NOT EXISTS idx_project_items_status ON project_items(status);
CREATE INDEX IF NOT EXISTS idx_project_items_issue  ON project_items(issue_number);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (2, 'Project tables: project_definitions, project_fields, project_items');
