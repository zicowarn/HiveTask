-- 订阅颜色（用户反馈 2026-09-18）：每个订阅可自选事件色，区分多订阅。
-- NULL = 默认样式（accent 实底 + 虚线描边）。ALTER 不支持 IF NOT EXISTS，
-- 依赖 PRAGMA user_version 保证只执行一次。
ALTER TABLE calendar_feeds ADD COLUMN color TEXT;
