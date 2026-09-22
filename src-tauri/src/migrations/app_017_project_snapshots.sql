-- 项目分析（《架构设计-Projects本地看板》Q9 报表的 v1 数据基础）
--
-- 为什么是每日计数快照、而不是"journal 重放任意历史"：
--   ① 平台镜像数据拿不到列间流转历史 → 只能"从开始追踪那天起"（history starts
--      when tracking starts，Q9 已明示）；
--   ② 本地真源的精确重放依赖**容器 journal 化**，那是二期（多端同步）的基建。
-- 快照是两者都能用、且**今天就开始积累**的最小面：越早记录，趋势越早可用。
--
-- counts = JSON，只存渲染所需的最小面：
--   { "total": 12, "status": { "<optionId>": 5, ... }, "labels": { "<optionId>": "Todo" } }
-- labels 一起存是为了选项后来被改名/删除时历史仍可读（id 是渲染键，名字是当时的真值）。
CREATE TABLE IF NOT EXISTS project_snapshots (
    project_id TEXT NOT NULL,
    day        TEXT NOT NULL,   -- YYYY-MM-DD（本地日）
    counts     TEXT NOT NULL,   -- 上述 JSON
    taken_at   TEXT NOT NULL,
    PRIMARY KEY (project_id, day)
);
