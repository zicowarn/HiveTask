//! app.db——登记层（与仓库业务层 `<repo>/.hivetask/` 分离，见设计文档
//! 《仓库登记与类型》Q3）。两张表：connections（来源连接，命名实体）
//! 与 repos（登记指针，真数据在仓库侧；删除只删指针）。
//!
//! 位置：各 OS 标准 app data 目录下的 app.db（identifier 固定
//! dev.zicowarn.hivetask）。迁移与 hivetask.db 同模式（user_version）。

use anyhow::Context as _;
use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;

const APP_IDENTIFIER: &str = "dev.zicowarn.hivetask";
const CURRENT_APP_SCHEMA_VERSION: i64 = 1;

const APP_MIGRATION_001: &str = include_str!("migrations/app_001_registry.sql");

pub fn app_data_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")?;
        Some(PathBuf::from(home).join("Library/Application Support").join(APP_IDENTIFIER))
    }
    #[cfg(windows)]
    {
        let base = std::env::var_os("APPDATA")?;
        Some(PathBuf::from(base).join(APP_IDENTIFIER))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = std::env::var_os("HOME")?;
        Some(PathBuf::from(home).join(".local/share").join(APP_IDENTIFIER))
    }
}

pub fn open() -> anyhow::Result<Connection> {
    let dir = app_data_dir().context("无法定位 app data 目录")?;
    std::fs::create_dir_all(&dir).context("创建 app data 目录失败")?;
    let conn = Connection::open(dir.join("app.db")).context("打开 app.db 失败")?;
    migrate(&conn)?;
    seed_github_connection(&conn);
    Ok(conn)
}

/// 首次启动播种 GitHub 连接（gh 托管凭据），保证来源列表非空。
fn seed_github_connection(conn: &Connection) {
    let has: Option<String> = conn
        .query_row(
            "SELECT id FROM connections WHERE platform = 'github' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .ok();
    if has.is_none() {
        let _ = conn.execute(
            "INSERT INTO connections (id, platform, host, label, source_state, created_at)
             VALUES ('conn-github', 'github', 'github.com', 'GitHub', 'auto', ?1)",
            (chrono_like_now(),),
        );
    }
}

fn migrate(conn: &Connection) -> anyhow::Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version < 1 {
        conn.execute_batch(APP_MIGRATION_001).context("app 迁移 001 失败")?;
    }
    conn.pragma_update(None, "user_version", CURRENT_APP_SCHEMA_VERSION)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionEntry {
    pub id: String,
    pub platform: String,
    pub host: String,
    pub label: String,
    pub source_state: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    pub id: String,
    pub path: Option<String>,
    pub remote_url: Option<String>,
    pub display_name: Option<String>,
    pub connection_id: Option<String>,
    /// JOIN connections 派生（NULL 连接 = 自动解析，按 host 推断）。
    pub connection_label: Option<String>,
    pub platform: Option<String>,
    pub last_opened_at: String,
}

fn now() -> String {
    // RFC3339 UTC，与 meta 表 strftime 口径一致。
    chrono_like_now()
}

/// 极简 UTC 时间戳（避免为时间格式引入 chrono）。
fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    // days since epoch → civil date (Howard Hinnant 算法)
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// host → 平台推断（自动解析口径）：github 直判，gitee.com 直判，
/// 含 gitea 的自建域推断为 gitea；其余 None（unknown，不建连接）。
pub fn platform_for_host(host: &str) -> Option<String> {
    let h = host.to_lowercase();
    if h.contains("github") {
        Some("github".into())
    } else if h == "gitee.com" || h.ends_with(".gitee.com") {
        Some("gitee".into())
    } else if h.contains("gitea") {
        Some("gitea".into())
    } else {
        None
    }
}

fn ensure_connection_for_host(conn: &Connection, host: &str) -> anyhow::Result<Option<String>> {
    let Some(platform) = platform_for_host(host) else { return Ok(None) };
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM connections WHERE platform = ?1 AND host = ?2",
            (platform.as_str(), host),
            |row| row.get::<_, String>(0),
        )
        .ok()
    {
        return Ok(Some(id));
    }
    let id = uuid();
    conn.execute(
        "INSERT INTO connections (id, platform, host, label, source_state, created_at)
         VALUES (?1, ?2, ?3, ?4, 'auto', ?5)",
        (&id, platform.as_str(), host, host, now()),
    )?;
    Ok(Some(id))
}

/// 仅远端登记仓库的缓存目录（app data 下，按 owner/repo 隔离）。
/// storage.rs 把它当普通仓库目录用（内部建 .hivetask/）。
pub fn remote_cache_dir(owner: &str, repo: &str) -> Option<PathBuf> {
    app_data_dir().map(|d| d.join("repos-cache").join(owner).join(repo))
}

pub(crate) fn uuid() -> String {
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("r{:x}{:x}", n, std::process::id() as u64)
}

// ---- 命令 ----

fn connection_list_in(conn: &Connection) -> Result<Vec<ConnectionEntry>, String> {
    let conn = conn;
    let mut stmt = conn
        .prepare("SELECT id, platform, host, label, source_state, created_at FROM connections ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ConnectionEntry {
                id: row.get(0)?,
                platform: row.get(1)?,
                host: row.get(2)?,
                label: row.get(3)?,
                source_state: row.get(4)?,
                created_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn connection_list() -> Result<Vec<ConnectionEntry>, String> {
    let conn = open().map_err(|e| e.to_string())?;
    connection_list_in(&conn)
}

#[tauri::command]
pub fn connection_save(
    id: Option<String>,
    platform: String,
    host: String,
    label: String,
) -> Result<ConnectionEntry, String> {
    let conn = open().map_err(|e| e.to_string())?;
    let id = id.unwrap_or_else(uuid);
    conn.execute(
        "INSERT INTO connections (id, platform, host, label, source_state, created_at)
         VALUES (?1, ?2, ?3, ?4, 'user_set', ?5)
         ON CONFLICT(id) DO UPDATE SET platform=excluded.platform, host=excluded.host,
            label=excluded.label, source_state='user_set'",
        (&id, platform.as_str(), host.as_str(), label.as_str(), now()),
    )
    .map_err(|e| e.to_string())?;
    connection_list_in(&conn)?.into_iter().find(|c| c.id == id).ok_or_else(|| "保存后未找到条目".to_string())
}

#[tauri::command]
pub fn connection_delete(id: String) -> Result<(), String> {
    let conn = open().map_err(|e| e.to_string())?;
    // 引用它的仓库回退自动解析，不级联删仓库。
    conn.execute("UPDATE repos SET connection_id = NULL WHERE connection_id = ?1", (&id,))
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM connections WHERE id = ?1", (&id,))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn repo_list_in(conn: &Connection) -> Result<Vec<RepoEntry>, String> {
    let conn = conn;
    let mut stmt = conn
        .prepare(
            "SELECT r.id, r.path, r.remote_url, r.display_name, r.connection_id,
                    c.label, c.platform, r.last_opened_at
             FROM repos r LEFT JOIN connections c ON c.id = r.connection_id
             ORDER BY r.last_opened_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RepoEntry {
                id: row.get(0)?,
                path: row.get(1)?,
                remote_url: row.get(2)?,
                display_name: row.get(3)?,
                connection_id: row.get(4)?,
                connection_label: row.get(5)?,
                platform: row.get(6)?,
                last_opened_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 按 path upsert（打开即登记）：读 origin、解析 host、自动建/关联连接、
/// 刷新 last_opened_at。幂等——切换仓库时重复调用即视为"打开"。
#[tauri::command]
pub fn repo_list() -> Result<Vec<RepoEntry>, String> {
    let conn = open().map_err(|e| e.to_string())?;
    repo_list_in(&conn)
}

#[tauri::command]
pub fn repo_register(path: String) -> Result<RepoEntry, String> {
    let conn = open().map_err(|e| e.to_string())?;
    let repo = PathBuf::from(&path);
    let remote_url = crate::gh::git_origin(&repo);
    let host = remote_url.as_deref().and_then(|u| {
        let s = u
            .strip_prefix("https://")
            .or_else(|| u.strip_prefix("http://"))
            .unwrap_or(u);
        let s = s.split_once('@').map(|(_, rest)| rest).unwrap_or(s);
        s.split('/').next()?.split(':').next()?.to_lowercase().into()
    });
    let connection_id = match host.as_deref() {
        Some(h) => ensure_connection_for_host(&conn, h).map_err(|e| e.to_string())?,
        None => None,
    };
    let display = path.split('/').filter(|p| !p.is_empty()).last().unwrap_or(&path).to_string();

    let existing: Option<String> = conn
        .query_row("SELECT id FROM repos WHERE path = ?1", (&path,), |row| row.get(0))
        .ok();
    let id = existing.unwrap_or_else(uuid);
    conn.execute(
        "INSERT INTO repos (id, path, display_name, connection_id, created_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(path) DO UPDATE SET last_opened_at=excluded.last_opened_at",
        (&id, &path, &display, &connection_id, now()),
    )
    .map_err(|e| e.to_string())?;

    repo_list_in(&conn)?.into_iter().find(|r| r.path.as_deref() == Some(path.as_str())).ok_or_else(|| "登记后未找到条目".to_string())
}

/// 解析 target：按 path 命中 → (remote_url, Some(path))；按 remote_url
/// 命中 → (remote_url, None)。未命中 → None（调用方回退磁盘读取）。
pub fn repo_find_by_target(target: &str) -> Option<(String, Option<PathBuf>, Option<String>)> {
    let conn = open().ok()?;
    let row = conn
        .query_row(
            "SELECT r.remote_url, r.path, c.platform FROM repos r
             LEFT JOIN connections c ON c.id = r.connection_id
             WHERE r.path = ?1 OR r.remote_url = ?1",
            (target,),
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .ok()?;
    let (remote_url, path, platform) = row;
    Some((remote_url?, path.map(PathBuf::from), platform))
}

/// 仅远端登记：URL 解析 host/owner/repo，自动建连接，path 为 NULL。
#[tauri::command]
pub fn repo_register_remote(url: String) -> Result<RepoEntry, String> {
    let conn = open().map_err(|e| e.to_string())?;
    let (host, slug) = crate::source::split_host_slug(&url)
        .ok_or_else(|| format!("无法从 URL 解析 host: {url}"))?;
    let connection_id =
        ensure_connection_for_host(&conn, &host).map_err(|e| e.to_string())?;
    let display = slug.split('/').last().unwrap_or(&slug).to_string();
    let id = uuid();
    conn.execute(
        "INSERT INTO repos (id, remote_url, display_name, connection_id, created_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        (&id, &url, &display, &connection_id, now()),
    )
    .map_err(|e| e.to_string())?;
    repo_list_in(&conn)?.into_iter().find(|r| r.id == id).ok_or_else(|| "登记后未找到条目".to_string())
}

#[tauri::command]
pub fn repo_delete(id: String) -> Result<(), String> {
    let conn = open().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM repos WHERE id = ?1", (&id,)).map_err(|e| e.to_string())?;
    Ok(())
}
