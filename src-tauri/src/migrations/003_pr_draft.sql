-- 003: PR 草稿标记（对应 gh 的 isDraft 字段）。
-- 注意：ALTER TABLE 不支持 IF NOT EXISTS，依赖 PRAGMA user_version 保证只执行一次。
ALTER TABLE pulls ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0;
