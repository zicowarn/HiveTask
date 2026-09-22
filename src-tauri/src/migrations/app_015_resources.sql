-- 甘特计划面 · 资源分配与负载模型（§5-bis，照 jordium 参考实现设计）
-- 资源目录**跨项目共享**（人与设备本就跨项目）；分配挂条目（结构扩展泳道）；
-- 资源级日历例外（请假/停机）与公司级例外（假日订阅）分开。

-- 资源目录：origin NULL = 本地自定义（设备/他人）；'gh' = 平台 assignees 派生镜像
CREATE TABLE IF NOT EXISTS resources (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    title      TEXT,            -- 职务（jordium Resource.title）
    type       TEXT NOT NULL DEFAULT 'Human',  -- Human | Device | Others | 自定义
    department TEXT,
    capacity   REAL,            -- 每日标准工时（小时）；NULL = 用全局默认
    color      TEXT,
    origin     TEXT,
    created_at TEXT NOT NULL
);

-- 分配：条目 × 资源 + 占用比例（照库口径 20–100 百分数）
CREATE TABLE IF NOT EXISTS item_resources (
    item_id     TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    allocation  INTEGER NOT NULL DEFAULT 100,
    origin      TEXT,           -- NULL = 容器真源；'gh' = assignees 派生镜像
    PRIMARY KEY (item_id, resource_id)
);

-- 资源级工作日历例外（请假/停机）：working=0 不计工时、=1 额外计工时（加班）
CREATE TABLE IF NOT EXISTS resource_calendar_exceptions (
    id          TEXT PRIMARY KEY,
    resource_id TEXT,           -- NULL = 全员（公司级，v1 主要走假日订阅，此列预留）
    name        TEXT,
    start_at    TEXT NOT NULL,  -- YYYY-MM-DD 或 YYYY-MM-DD HH:mm
    end_at      TEXT NOT NULL,
    working     INTEGER NOT NULL DEFAULT 0
);
