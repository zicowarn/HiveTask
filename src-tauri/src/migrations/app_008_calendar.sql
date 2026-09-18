-- 日历订阅（S3-b）：ICS 图层。url 属准凭据——任何日志/错误信息不得包含完整 URL；
-- 事件缓存进库（cached_payload）不落文件，断网读缓存。
CREATE TABLE calendar_feeds (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    url            TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    last_synced_at TEXT,
    cached_payload TEXT
);
