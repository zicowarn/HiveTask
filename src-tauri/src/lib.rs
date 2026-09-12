//! Tauri command surface — the bridge between the Vue workbench and the
//! local core (gh CLI + SQLite cache). This same core will later back the
//! headless MCP server from Phase 4.

mod credentials;
mod gh;
mod git;
mod models;
mod pty;
mod source;
mod storage;

use source::{IssueStateFilter, Kind, MergeMethod, PullStateFilter};

use std::path::PathBuf;

use tauri_plugin_dialog::DialogExt;

use models::{Comment, HealthInfo, Issue, Pull, RepoInfo};

/// gh CLI availability, for the onboarding banner.
/// Frontend log bridge (zero npm deps): the webview forwards one line per
/// call; plugin writes to the OS log dir alongside Rust-side entries.
#[tauri::command]
fn log_line(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("{message}"),
        "warn" => log::warn!("{message}"),
        "info" => log::info!("{message}"),
        _ => log::debug!("{message}"),
    }
}

#[tauri::command]
fn health_check() -> HealthInfo {
    HealthInfo {
        gh_available: gh::find_gh().is_some(),
        gh_path: gh::find_gh().map(|p| p.display().to_string()),
        gh_version: gh::gh_version(),
    }
}

/// Native directory picker; returns the selected git repository path.
#[tauri::command]
async fn pick_repo(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::FilePath;

    let (tx, mut rx) = tauri::async_runtime::channel::<Option<String>>(1);
    window
        .dialog()
        .file()
        .set_title("选择本地 Git 仓库")
        .pick_folder(move |path| {
            let value: Option<String> = path
                .map(|p| match p {
                    FilePath::Path(path_buf) => path_buf.to_string_lossy().to_string(),
                    FilePath::Url(url) => url
                        .to_file_path()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default(),
                })
                .filter(|s| !s.is_empty());
            let _ = tx.blocking_send(value);
        });
    // recv() returns None only if all senders are dropped.
    rx.recv().await.ok_or_else(|| "对话框已关闭".to_string())
}

#[tauri::command]
fn repo_info(repo_path: String) -> RepoInfo {
    let path = PathBuf::from(&repo_path);
    RepoInfo {
        origin: gh::git_origin(&path),
        valid: path.is_dir(),
        path: repo_path,
    }
}

/// Fetch issues from GitHub via gh, replace the local cache, return fresh data.
#[tauri::command]
fn refresh_issues(repo_path: String, state: String, limit: u32) -> Result<Vec<Issue>, String> {
    let repo = PathBuf::from(&repo_path);
    let filter = IssueStateFilter::parse(&state).map_err(|e| e.to_string())?;
    let issues = source::source_for(&repo).map_err(|e| e.to_string())?.fetch_issues(&repo, filter, limit).map_err(|e| e.to_string())?;
    let mut conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::replace_issues(&mut conn, &state, &issues).map_err(|e| e.to_string())?;
    storage::stamp_synced(&conn, &format!("synced:issues:{state}")).map_err(|e| e.to_string())?;
    Ok(issues)
}

/// Read issues from the offline cache without touching the network.
#[tauri::command]
fn list_cached_issues(repo_path: String, state: String) -> Result<Vec<Issue>, String> {
    let repo = PathBuf::from(&repo_path);
    let conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::list_issues(&conn, &state).map_err(|e| e.to_string())
}

#[tauri::command]
fn cached_issue_count(repo_path: String, state: String) -> Result<i64, String> {
    let repo = PathBuf::from(&repo_path);
    let conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::cached_issue_count(&conn, &state).map_err(|e| e.to_string())
}

/// Fetch pull requests via gh, replace the local cache, return fresh data.
/// `state` is "open" | "closed" | "merged" | "all".
#[tauri::command]
fn refresh_pulls(repo_path: String, state: String, limit: u32) -> Result<Vec<Pull>, String> {
    let repo = PathBuf::from(&repo_path);
    let filter = PullStateFilter::parse(&state).map_err(|e| e.to_string())?;
    let pulls = source::source_for(&repo).map_err(|e| e.to_string())?.fetch_pulls(&repo, filter, limit).map_err(|e| e.to_string())?;
    let mut conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::replace_pulls(&mut conn, &state, &pulls).map_err(|e| e.to_string())?;
    storage::stamp_synced(&conn, &format!("synced:pulls:{state}")).map_err(|e| e.to_string())?;
    Ok(pulls)
}

/// Fetch one PR's full record via `gh pr view` (heavy nested fields are not
/// part of the list query), upsert it into the cache, and return it.
#[tauri::command]
fn refresh_pull_detail(repo_path: String, number: i64) -> Result<Pull, String> {
    let repo = PathBuf::from(&repo_path);
    let pull = source::source_for(&repo).map_err(|e| e.to_string())?.fetch_pull_detail(&repo, number).map_err(|e| e.to_string())?;
    let conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::upsert_pull(&conn, &pull).map_err(|e| e.to_string())?;
    Ok(pull)
}

/// Read PRs from the offline cache without touching the network.
#[tauri::command]
fn list_cached_pulls(repo_path: String, state: String) -> Result<Vec<Pull>, String> {
    let repo = PathBuf::from(&repo_path);
    let conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::list_pulls(&conn, &state).map_err(|e| e.to_string())
}

#[tauri::command]
fn cached_pull_count(repo_path: String, state: String) -> Result<i64, String> {
    let repo = PathBuf::from(&repo_path);
    let conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::cached_pull_count(&conn, &state).map_err(|e| e.to_string())
}

/// Merge a pull request; upserts the fresh full record and returns it.
#[tauri::command]
fn merge_pull(repo_path: String, number: i64, method: String) -> Result<Pull, String> {
    let repo = PathBuf::from(&repo_path);
    let method = MergeMethod::parse(&method).map_err(|e| e.to_string())?;
    let pull = source::source_for(&repo).map_err(|e| e.to_string())?.merge_pull(&repo, number, method).map_err(|e| e.to_string())?;
    let conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::upsert_pull(&conn, &pull).map_err(|e| e.to_string())?;
    Ok(pull)
}

/// Commit history across all local + remote tips, for the graph renderer.
#[tauri::command]
fn git_history(repo_path: String, limit: Option<u32>) -> Result<models::GitHistoryPage, String> {
    git::history(&repo_path, limit).map_err(|e| e.to_string())
}

/// Branch list with local/remote kind and ahead/behind vs upstream.
#[tauri::command]
fn git_branches(repo_path: String) -> Result<Vec<models::BranchRow>, String> {
    git::branches(&repo_path).map_err(|e| e.to_string())
}

/// `git fetch --all` through the git CLI (reuses credential helpers).
#[tauri::command]
fn git_fetch(repo_path: String) -> Result<(), String> {
    git::fetch(&repo_path).map_err(|e| e.to_string())
}

/// All recorded sync timestamps for the status bar's "last updated" cell.
#[tauri::command]
fn list_synced_at(repo_path: String) -> Result<Vec<(String, String)>, String> {
    let repo = PathBuf::from(&repo_path);
    let conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::list_synced(&conn).map_err(|e| e.to_string())
}

/// User-initiated connectivity probe. Ok => online; the raw error string
/// lets the frontend classify network failures (offline) from auth ones.
#[tauri::command]
fn probe_network() -> Result<(), String> {
    gh::probe_network().map_err(|e| e.to_string())
}

/// Read an entity's comments from the offline cache (cache-first rendering).
#[tauri::command]
fn list_cached_comments(
    repo_path: String,
    kind: String,
    number: i64,
) -> Result<Vec<Comment>, String> {
    let kind = Kind::parse(&kind).map_err(|e| e.to_string())?;
    let repo = PathBuf::from(&repo_path);
    let conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::list_comments(&conn, kind.as_str(), number).map_err(|e| e.to_string())
}

/// Fetch an entity's comments via gh, replace the cache slice, return fresh.
#[tauri::command]
fn fetch_comments(repo_path: String, kind: String, number: i64) -> Result<Vec<Comment>, String> {
    let kind = Kind::parse(&kind).map_err(|e| e.to_string())?;
    let repo = PathBuf::from(&repo_path);
    let comments = source::source_for(&repo).map_err(|e| e.to_string())?.fetch_comments(&repo, kind, number).map_err(|e| e.to_string())?;
    let mut conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::replace_comments(&mut conn, kind.as_str(), number, &comments).map_err(|e| e.to_string())?;
    Ok(comments)
}

/// Post a comment via gh and return the fresh conversation (write-through).
#[tauri::command]
fn add_comment(
    repo_path: String,
    kind: String,
    number: i64,
    body: String,
) -> Result<Vec<Comment>, String> {
    let kind = Kind::parse(&kind).map_err(|e| e.to_string())?;
    let repo = PathBuf::from(&repo_path);
    let comments = source::source_for(&repo).map_err(|e| e.to_string())?.add_comment(&repo, kind, number, &body).map_err(|e| e.to_string())?;
    let mut conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::replace_comments(&mut conn, kind.as_str(), number, &comments).map_err(|e| e.to_string())?;
    Ok(comments)
}

/// Close or reopen an issue; patches the cache row and returns the fresh
/// entity so the frontend can patch both stores from one source of truth.
#[tauri::command]
fn set_issue_state(repo_path: String, number: i64, closed: bool) -> Result<Issue, String> {
    let repo = PathBuf::from(&repo_path);
    let issue = source::source_for(&repo).map_err(|e| e.to_string())?.set_issue_state(&repo, number, closed).map_err(|e| e.to_string())?;
    let conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::update_issue_state(&conn, number, &issue.state).map_err(|e| e.to_string())?;
    Ok(issue)
}

/// Close or reopen a pull request; upserts the fresh full record.
#[tauri::command]
fn set_pull_state(repo_path: String, number: i64, closed: bool) -> Result<Pull, String> {
    let repo = PathBuf::from(&repo_path);
    let pull = source::source_for(&repo).map_err(|e| e.to_string())?.set_pull_state(&repo, number, closed).map_err(|e| e.to_string())?;
    let conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::upsert_pull(&conn, &pull).map_err(|e| e.to_string())?;
    Ok(pull)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("hivetask".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            health_check,
            pick_repo,
            repo_info,
            refresh_issues,
            list_cached_issues,
            cached_issue_count,
            refresh_pulls,
            refresh_pull_detail,
            list_cached_pulls,
            cached_pull_count,
            list_cached_comments,
            fetch_comments,
            add_comment,
            set_issue_state,
            set_pull_state,
            list_synced_at,
            probe_network,
            merge_pull,
            log_line,
            git_history,
            git_branches,
            git_fetch,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            credentials::credential_set,
            credentials::credential_get,
            credentials::credential_delete
        ])
        .manage(pty::PtyMap(std::sync::Mutex::new(std::collections::HashMap::new())))
        .run(tauri::generate_context!())
        .expect("error while running HiveTask");
}
