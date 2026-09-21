-- 重复日程（S4 用户反馈）：'' = 不重复；daily/weekly/monthly/yearly 按起始日
-- 锚定（每周=同星期、每月=同日、每年=同月日，短月/平年自然跳过）。
-- v1 不做单次例外编辑（改系列 = 改全部，明确挂账）。
ALTER TABLE calendar_events ADD COLUMN recur TEXT NOT NULL DEFAULT '';
