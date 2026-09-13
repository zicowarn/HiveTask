-- 项目归属接入（用户定案：项目与接入对应，同仓库口径——
-- 切换项目对话框按接入分 Tab，项目挂在各自的接入标签下）。
-- connection_id 为逻辑外键：NULL = 本地/未接入（收进「本地」Tab）。

ALTER TABLE projects ADD COLUMN connection_id TEXT;
