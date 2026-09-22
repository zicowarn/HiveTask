-- 条目级归档（对齐 GitHub Projects 的 Archive，2026-09-22 取证）：
-- 归档把条目移出**所有视图**（看板/表格/线路图/甘特/导出），但保留条目上下文
-- ——不删行、不碰 Issue/仓库实体、不写 journal（那是「从项目中移除」= item_remove_in）。
-- 平台对照：item ⋯ → Archive（快捷键 E）；回收走「Archived items」页 → Restore。
--
-- NULL = 未归档（不引入 0/1 标志位：归档时间是归档页要显示的信息，一行顶两用）。
ALTER TABLE project_items ADD COLUMN archived_at TEXT;
