-- 甘特计划面 · 结构扩展泳道：《架构设计-甘特计划面》§3
-- 依赖边（FS：item 完成 depends_on 才能开始 item）。容器真源（origin NULL =
-- 草稿/本地条目建的关系）与平台镜像（origin = 'gh'/'gitea'，G1 拉取整组重写）
-- 同表共存，靠 origin 分流，两条真源永不同表打架。
-- 级联：条目删除时双向清理（代码级，app.db 沿用逻辑外键惯例）。

CREATE TABLE IF NOT EXISTS project_item_deps (
    item_id    TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    origin     TEXT,
    PRIMARY KEY (item_id, depends_on)
);
