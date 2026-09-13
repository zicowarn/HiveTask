-- app migration 002: repos.visibility — 平台侧仓库可见性缓存
-- ('public' | 'private'；NULL = 未探测 / 本地无 remote / 来源未知)。
-- 探测是网络调用（Source::repo_visibility），结果落库避免重复打 API。
ALTER TABLE repos ADD COLUMN visibility TEXT;
