//! 「工作内容」级 UI 偏好的持久化（app.db `prefs` 表，`ui.` 命名空间）。
//!
//! 为什么这些键不该住在 webview 的 localStorage：**localStorage 按「安装形态 + 来源」
//! 分库**——开发态是裸二进制（`~/Library/WebKit/<进程名>`、来源 `http://localhost:1420`），
//! 装成 .app 后目录名按 bundle id、来源变 `tauri://localhost`。于是同一台机器上，
//! 「开发态攒的东西」与「安装版的库」是两份，用户在安装版里等于从零开始。
//!
//! 而 app.db 的路径由 `appdb::app_data_dir()` 的常量决定，**与 bundle 无关**：开发、
//! 安装、换机（配合设备包）读的都是同一份。所以凡是「我的工作内容指向」——知识库根与
//! 最近文件、项目视图配置、工作台布局、分支 review 的 base——都该落在这里；而「这台机器
//! 上的偏好」（主题 / 语言 / 终端 shell / 同步间隔 / 各类面板 Mode）留在 localStorage
//! 由用户随手重选即可。
//!
//! 前端的 localStorage 退化为**本安装形态的镜像**：启动时由 app.db 灌入，写入时两边都写
//! （`src/ui-prefs.ts`），既有同步读取点因此不必改成异步。
//!
//! 命名空间守卫：本模块只放行 `ui.` 前缀的键——`prefs` 表里还有别的东西
//! （如知识库「打开方式」，那条是**权限级配置**：能改它就能指定任意程序，必须由 Rust 侧
//! 的专用命令管），不得被前端通用 KV 通道碰到。

use rusqlite::Connection;

/// 前端可经通用通道读写的键前缀（`ui.` 之外的键一律拒绝）。
pub const UI_PREFIX: &str = "ui.";

fn ensure_ui_key(key: &str) -> Result<(), String> {
    if !key.starts_with(UI_PREFIX) {
        return Err(format!("键不在 {} 命名空间内：{key}", UI_PREFIX));
    }
    if key.len() > 200 {
        return Err("键过长".to_string());
    }
    Ok(())
}

/// 全部 `ui.` 键值对（升序）。
pub fn ui_prefs_get_all_in(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT key, value FROM prefs WHERE key LIKE ?1 || '%' ORDER BY key")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([UI_PREFIX], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|x| x.ok()).collect())
}

pub fn ui_prefs_set_in(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    ensure_ui_key(key)?;
    conn.execute(
        "INSERT INTO prefs (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, crate::resources::now_iso()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn ui_prefs_remove_in(conn: &Connection, key: &str) -> Result<(), String> {
    ensure_ui_key(key)?;
    conn.execute("DELETE FROM prefs WHERE key = ?1", (key,))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Tauri 命令 ----

/// 全部工作内容级 UI 偏好（启动时灌进 localStorage 镜像）。
#[tauri::command]
pub fn ui_prefs_get_all() -> Result<Vec<(String, String)>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    ui_prefs_get_all_in(&conn)
}

/// 写一条（键必须在 `ui.` 命名空间）。
#[tauri::command]
pub fn ui_prefs_set(key: String, value: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    ui_prefs_set_in(&conn, &key, &value)
}

#[tauri::command]
pub fn ui_prefs_remove(key: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    ui_prefs_remove_in(&conn, &key)
}

/// 应用数据目录（设置页展示「家在哪」+ 启动日志；与 bundle 无关的那条路径）。
#[tauri::command]
pub fn app_data_path() -> Result<String, String> {
    crate::appdb::app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "找不到应用数据目录".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::appdb::app_migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn round_trip_and_namespace_guard() {
        let conn = mem_db();
        assert_eq!(ui_prefs_get_all_in(&conn).unwrap(), vec![]);
        ui_prefs_set_in(&conn, "ui.kb.root", "/Users/me/notes").unwrap();
        ui_prefs_set_in(&conn, "ui.workbench", "{\"a\":1}").unwrap();
        // 覆盖写（同键更新而非报错）
        ui_prefs_set_in(&conn, "ui.kb.root", "/Users/me/notes2").unwrap();
        let all = ui_prefs_get_all_in(&conn).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0], ("ui.kb.root".to_string(), "/Users/me/notes2".to_string()));
        // 删除
        ui_prefs_remove_in(&conn, "ui.workbench").unwrap();
        assert_eq!(ui_prefs_get_all_in(&conn).unwrap().len(), 1);
        // 命名空间守卫：别的 prefs（如知识库打开方式）不得经此通道
        assert!(ui_prefs_set_in(&conn, "kb.openWith", "{}").is_err());
        assert!(ui_prefs_remove_in(&conn, "kb.openWith").is_err());
        // 既有键还在表里（只是不列出来）
        conn.execute(
            "INSERT INTO prefs (key, value, updated_at) VALUES ('kb.openWith', '{}', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        assert_eq!(ui_prefs_get_all_in(&conn).unwrap().len(), 1, "只列 ui. 前缀");
    }
}
