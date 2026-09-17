-- 应用级偏好（键值）：目前只存知识库的「打开方式」。
-- 放 app.db 而不是 webview localStorage，是因为**打开动作由 Rust 执行**：
-- 谁要读这份配置就该由谁持有（前端只通过命令读写，不能直接指定要启动的程序——
-- 那会把「打开文件」变成任意程序启动的入口）。

CREATE TABLE prefs (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
