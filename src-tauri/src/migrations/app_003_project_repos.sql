-- Project ↔ repo bindings (P4 看板补充，应用级 app.db)。
--
-- 用户的定案：项目创建/管理仿照仓库登记——项目要显式绑定已登记仓库
-- （仓库自带来源连接，接入配置标签随 repos 行携带），看板才能回到线上
-- 仓库的 Issue。repo_id 同 project_items：逻辑外键（仓库删除 → 悬挂，
-- 绑定行读取时跳过，不阻断登记表删除）。

CREATE TABLE project_repos (
    project_id TEXT NOT NULL REFERENCES projects(id),
    repo_id    TEXT NOT NULL,             -- 逻辑外键 → repos(id)
    position   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, repo_id)
);
