-- 甘特计划面 · 结构扩展泳道（父子）：《架构设计-甘特计划面》§3
-- 一个条目至多一个上级（PK = item_id）。容器真源（origin NULL = 我们排的计划）
-- 与平台镜像（origin = 'gh'/'gitea'，来自平台 sub-issues，刷新整组重写）同表。
-- 级联：条目删除时双向清理（代码级，app.db 沿用逻辑外键惯例）。

CREATE TABLE IF NOT EXISTS project_item_parents (
    item_id   TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    origin    TEXT
);
