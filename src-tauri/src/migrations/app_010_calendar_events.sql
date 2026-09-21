-- 日程（S4）：用户手建事件的唯一真源（设计见 KB《架构设计-日历面板》§5.2）。
-- 落 app.db 主库（非仓库数据、非 UI 态）；remind_at/reminded_at 供本地通知
-- 层使用（防重启重复通知）；v1 为日期级（无时刻语义）。
CREATE TABLE calendar_events (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    start_date  TEXT NOT NULL,      -- YYYY-MM-DD
    end_date    TEXT,               -- NULL = 单日
    notes       TEXT,
    remind_at   TEXT,               -- NULL = 不提醒（datetime-local 形态原样存）
    reminded_at TEXT,               -- 通知已发标记（RFC3339）
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
