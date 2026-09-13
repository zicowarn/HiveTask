-- app.db 登记层（与 hivetask.db 分离，见设计文档《仓库登记与类型》）。
-- connections：来源连接（命名实体，platform + host + 凭据引用）；
-- repos：登记指针（path/remote_url 可空之一，删除只删指针）。

CREATE TABLE connections (
    id           TEXT PRIMARY KEY,
    platform     TEXT NOT NULL,     -- github|gitea|gitee|gitlab
    host         TEXT NOT NULL,
    label        TEXT NOT NULL,
    token_account TEXT NOT NULL DEFAULT 'token',
    source_state TEXT NOT NULL DEFAULT 'auto',  -- auto|probed|user_set
    probed_at    TEXT,
    created_at   TEXT NOT NULL
);

CREATE TABLE repos (
    id             TEXT PRIMARY KEY,
    path           TEXT UNIQUE,       -- 仅远端登记时 NULL（唯一性仅对非空）
    remote_url     TEXT,
    display_name   TEXT,
    connection_id  TEXT REFERENCES connections(id),
    account        TEXT,              -- 预留：仓库绑定账户（分发期）
    group_tag      TEXT,
    sharing        INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    last_opened_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_repos_path ON repos(path) WHERE path IS NOT NULL;
CREATE INDEX idx_repos_connection ON repos(connection_id);
