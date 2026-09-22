-- 条目的平台引用快照（origin_url + source_type）——设备包携带的就是这两个字段。
-- 导入时按 origin_url 重解析本机登记表：命中挂接（repo_id），**未命中留档**而不是
-- 丢弃；之后登记/打开该仓库时用 `project_relink_origin` 按 origin_url 回填 repo_id。
-- 没有这两列的话，新设备上导入的引用卡既不知道属于哪个仓库、也无法修好
-- （2026-09-22 修：此前导入未命中直接写 repo_id = NULL 且 origin 一起丢）。
ALTER TABLE project_items ADD COLUMN origin_url  TEXT;
ALTER TABLE project_items ADD COLUMN origin_type TEXT;
