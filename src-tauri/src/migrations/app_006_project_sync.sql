-- 项目数据同步时间：拉取线上 Projects 条目（GH ProjectsV2）后盖章。
-- NULL = 从未同步（纯本地项目恒为 NULL）。
ALTER TABLE projects ADD COLUMN synced_at TEXT;
