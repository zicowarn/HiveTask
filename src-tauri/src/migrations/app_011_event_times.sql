-- 日程时刻扩展（用户反馈「日程应该有全天/有时刻之分」）：
-- all_day = 1（默认，兼容既有行）为全天日程（仅日期）；0 为有时刻日程
-- （start_time 必填 HH:MM，end_time 可选）。
ALTER TABLE calendar_events ADD COLUMN all_day INTEGER NOT NULL DEFAULT 1;
ALTER TABLE calendar_events ADD COLUMN start_time TEXT;
ALTER TABLE calendar_events ADD COLUMN end_time TEXT;
