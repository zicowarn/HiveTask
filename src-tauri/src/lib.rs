//! Tauri command surface — the bridge between the Vue workbench and the
//! local core (gh CLI + SQLite cache). This same core will later back the
//! headless MCP server from Phase 4.

mod gh;
mod models;
mod storage;

use std::path::PathBuf;

use tauri_plugin_dialog::DialogExt;

use models::{HealthInfo, Issue, RepoInfo};

/// gh CLI availability, for the onboarding banner.
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
        path: repo_path,
        origin: gh::git_origin(&path),
    }
}

/// Fetch issues from GitHub via gh, replace the local cache, return fresh data.
#[tauri::command]
fn refresh_issues(repo_path: String, state: String, limit: u32) -> Result<Vec<Issue>, String> {
    let repo = PathBuf::from(&repo_path);
    let issues = gh::fetch_issues(&repo, &state, limit).map_err(|e| e.to_string())?;
    let mut conn = storage::open(&repo).map_err(|e| e.to_string())?;
    storage::replace_issues(&mut conn, &state, &issues).map_err(|e| e.to_string())?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            health_check,
            pick_repo,
            repo_info,
            refresh_issues,
            list_cached_issues,
            cached_issue_count
        ])
        .run(tauri::generate_context!())
        .expect("error while running HiveTask");
}
