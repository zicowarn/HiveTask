-- Projects (P4 board v1) — application-level storage in app.db.
--
-- 设计定案（知识库《架构设计-Projects本地看板》Q6）：项目属应用而非仓库，
-- 跨来源聚合在这里成立。平台绑定四列 v1 不填（pull 镜像期才用）。
-- repo_id 是逻辑外键（不加 REFERENCES）：仓库从登记表删除后条目必须
-- 悬挂成 ghost（保留 repo_id+number 供重新关联）——本环境的 SQLite 强制
-- 物理外键，加了会把仓库删除整个卡死；ghost 由读取时 LEFT JOIN 判定。

CREATE TABLE projects (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    description     TEXT,
    group_tag       TEXT,
    -- 平台绑定（v1 不填，预留）：绑定的远端 Projects 引用
    platform_kind   TEXT,
    platform_host   TEXT,
    platform_ref    TEXT,
    sync_direction  TEXT,
    archived        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    last_opened_at  TEXT NOT NULL
);

CREATE TABLE project_fields (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind       TEXT NOT NULL,             -- builtin_status | single_select | text | number | date
    name       TEXT NOT NULL,
    options    TEXT,                      -- JSON [{id,name,color}]（单选类，数组序即列序）
    position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_project_fields_project ON project_fields(project_id);

CREATE TABLE project_items (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    kind        TEXT NOT NULL,            -- issue | pull | draft
    repo_id     TEXT,                     -- 逻辑外键 → repos(id)；悬挂 = ghost
    number      TEXT,                     -- 2026-09-13 修订：随 Issue.number TEXT 化；pull 存十进制文本
    draft_title TEXT,
    draft_body  TEXT,
    rank        TEXT NOT NULL,            -- 分数索引（列内排序，拖拽取相邻中值）
    added_at    TEXT NOT NULL
);
CREATE INDEX idx_project_items_project ON project_items(project_id);
CREATE INDEX idx_project_items_repo    ON project_items(repo_id);

CREATE TABLE project_field_values (
    item_id  TEXT NOT NULL REFERENCES project_items(id),
    field_id TEXT NOT NULL REFERENCES project_fields(id),
    value    TEXT,                        -- 单选存 option id；其余存字面值
    PRIMARY KEY (item_id, field_id)
);
