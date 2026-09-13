//! Tauri command surface — the bridge between the Vue workbench and the
//! local core (gh CLI + SQLite cache). This same core will later back the
//! headless MCP server from Phase 4.

mod appdb;
mod credentials;
mod gh;
mod gitea;
mod git;
mod journal;
mod local;
mod models;
mod projects;
mod pty;
mod source;
mod storage;

use source::{IssueStateFilter, Kind, MergeMethod, PullStateFilter};

/// Issue/PR 类命令的目标解析（阶段 B+C）：登记表 → 磁盘。
fn resolve(target: &str) -> Result<source::RepoRef, String> {
    source::resolve_target(target).map_err(|e| e.to_string())
}

/// Git 面板命令需要真实本地路径（git2）；仅远端登记明确报错。
/// hivetask.db 所在目录：本地克隆 → <repo>/.hivetask/；仅远端 →
/// app data 的 repos-cache/<owner>/<repo>/（storage.rs 零改动）。
/// 缓存命令的容错版：target 无法解析（非 git 目录）时退到 temp 隔离目录，
/// 让缓存读写降级为空集而不是报错。
fn storage_dir_for_target(target: &str) -> PathBuf {
    source::resolve_target(target)
        .map(|r| storage_dir_of(&r))
        .unwrap_or_else(|_| std::env::temp_dir().join("hivetask-orphan").join(target.replace('/', "_")))
}

fn storage_dir_of(repo: &source::RepoRef) -> PathBuf {
    if let Some(workdir) = &repo.workdir {
        return workdir.join(".hivetask");
    }
    appdb::remote_cache_dir(&repo.owner, &repo.repo)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("hivetask-{}-{}", repo.owner, repo.repo)))
}

fn local_dir_of(target: &str) -> Result<PathBuf, String> {
    if let Some((_, Some(path), _)) = appdb::repo_find_by_target(target) {
        if path.is_dir() {
            return Ok(path);
        }
    }
    let p = PathBuf::from(target);
    if p.is_dir() {
        return Ok(p);
    }
    Err("仅远端登记的仓库没有本地克隆，Git 面板不可用".to_string())
}

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

/// Device Flow 第一步：申请设备码与用户码。
#[tauri::command]
fn gh_device_flow_start() -> Result<gh::DeviceFlowStart, String> {
    gh::device_flow_start().map_err(|e| e.to_string())
}

/// Device Flow 第二步：阻塞轮询令牌（超时 180s，前端挂等待态即可）。
#[tauri::command]
fn gh_device_flow_poll(device_code: String, interval_secs: u64) -> Result<String, String> {
    gh::device_flow_poll(&device_code, interval_secs).map_err(|e| e.to_string())
}

/// token 喂入 gh 凭据库并校验登录态，返回登录名。
#[tauri::command]
fn gh_auth_with_token(token: String) -> Result<String, String> {
    gh::auth_with_token(&token).map_err(|e| e.to_string())
}

/// 当前 gh 登录名（未登录 → null）。
#[tauri::command]
fn gh_auth_user() -> Option<String> {
    gh::auth_user()
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
    // 与运行时路由同一条链（resolve_target：登记连接 > host 推断），
    // 状态栏来源标签不是独立猜测的第三套口径。
    let platform = resolve(&repo_path)
        .ok()
        .and_then(|r| r.platform.or_else(|| crate::appdb::platform_for_host(&r.host)));
    RepoInfo {
        origin: gh::git_origin(&path),
        valid: path.is_dir(),
        path: repo_path,
        platform,
    }
}

/// Fetch issues from GitHub via gh, replace the local cache, return fresh data.
#[tauri::command]
fn refresh_issues(repo_path: String, state: String, limit: u32) -> Result<Vec<Issue>, String> {
    let repo = resolve(&repo_path)?;
    let filter = IssueStateFilter::parse(&state).map_err(|e| e.to_string())?;
    let issues = source::source_for_ref(repo.platform.as_deref(), &repo.host).fetch_issues(&repo, filter, limit).map_err(|e| e.to_string())?;
    let mut conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
    storage::replace_issues(&mut conn, &state, &issues).map_err(|e| e.to_string())?;
    storage::stamp_synced(&conn, &format!("synced:issues:{state}")).map_err(|e| e.to_string())?;
    Ok(issues)
}

/// Read issues from the offline cache without touching the network.
#[tauri::command]
fn list_cached_issues(repo_path: String, state: String) -> Result<Vec<Issue>, String> {
    let conn = storage::open(&storage_dir_for_target(&repo_path)).map_err(|e| e.to_string())?;
    storage::list_issues(&conn, &state).map_err(|e| e.to_string())
}

#[tauri::command]
fn cached_issue_count(repo_path: String, state: String) -> Result<i64, String> {
    let conn = storage::open(&storage_dir_for_target(&repo_path)).map_err(|e| e.to_string())?;
    storage::cached_issue_count(&conn, &state).map_err(|e| e.to_string())
}

/// Fetch pull requests via gh, replace the local cache, return fresh data.
/// `state` is "open" | "closed" | "merged" | "all".
#[tauri::command]
fn refresh_pulls(repo_path: String, state: String, limit: u32) -> Result<Vec<Pull>, String> {
    let repo = resolve(&repo_path)?;
    let filter = PullStateFilter::parse(&state).map_err(|e| e.to_string())?;
    let pulls = source::source_for_ref(repo.platform.as_deref(), &repo.host).fetch_pulls(&repo, filter, limit).map_err(|e| e.to_string())?;
    let mut conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
    storage::replace_pulls(&mut conn, &state, &pulls).map_err(|e| e.to_string())?;
    storage::stamp_synced(&conn, &format!("synced:pulls:{state}")).map_err(|e| e.to_string())?;
    Ok(pulls)
}

/// Fetch one PR's full record via `gh pr view` (heavy nested fields are not
/// part of the list query), upsert it into the cache, and return it.
#[tauri::command]
fn refresh_pull_detail(repo_path: String, number: i64) -> Result<Pull, String> {
    let repo = resolve(&repo_path)?;
    let pull = source::source_for_ref(repo.platform.as_deref(), &repo.host).fetch_pull_detail(&repo, &number.to_string()).map_err(|e| e.to_string())?;
    let conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
    storage::upsert_pull(&conn, &pull).map_err(|e| e.to_string())?;
    Ok(pull)
}

/// Read PRs from the offline cache without touching the network.
#[tauri::command]
fn list_cached_pulls(repo_path: String, state: String) -> Result<Vec<Pull>, String> {
    let conn = storage::open(&storage_dir_for_target(&repo_path)).map_err(|e| e.to_string())?;
    storage::list_pulls(&conn, &state).map_err(|e| e.to_string())
}

#[tauri::command]
fn cached_pull_count(repo_path: String, state: String) -> Result<i64, String> {
    let conn = storage::open(&storage_dir_for_target(&repo_path)).map_err(|e| e.to_string())?;
    storage::cached_pull_count(&conn, &state).map_err(|e| e.to_string())
}

/// Merge a pull request; upserts the fresh full record and returns it.
#[tauri::command]
fn merge_pull(repo_path: String, number: i64, method: String) -> Result<Pull, String> {
    let method = MergeMethod::parse(&method).map_err(|e| e.to_string())?;
    let repo = resolve(&repo_path)?;
    let pull = source::source_for_ref(repo.platform.as_deref(), &repo.host).merge_pull(&repo, &number.to_string(), method).map_err(|e| e.to_string())?;
    let conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
    storage::upsert_pull(&conn, &pull).map_err(|e| e.to_string())?;
    Ok(pull)
}

/// Commit history across all local + remote tips, for the graph renderer.
#[tauri::command]
fn git_history(repo_path: String, limit: Option<u32>) -> Result<models::GitHistoryPage, String> {
    let dir = local_dir_of(&repo_path)?;
    git::history(&dir.to_string_lossy(), limit).map_err(|e| e.to_string())
}

/// Branch list with local/remote kind and ahead/behind vs upstream.
#[tauri::command]
fn git_branches(repo_path: String) -> Result<Vec<models::BranchRow>, String> {
    let dir = local_dir_of(&repo_path)?;
    git::branches(&dir.to_string_lossy()).map_err(|e| e.to_string())
}

/// `git fetch --all` through the git CLI (reuses credential helpers).
#[tauri::command]
fn git_fetch(repo_path: String) -> Result<(), String> {
    let dir = local_dir_of(&repo_path)?;
    git::fetch(&dir.to_string_lossy()).map_err(|e| e.to_string())
}

// ---- 本地分支 review（PR 工作区本地形态，纯 git 能力不扩 Source trait）----

#[tauri::command]
fn branch_review_list(repo_path: String, base: String) -> Result<Vec<models::ReviewBranch>, String> {
    let dir = local_dir_of(&repo_path)?;
    git::review_branch_list(&dir.to_string_lossy(), &base).map_err(|e| e.to_string())
}

#[tauri::command]
fn branch_review_diff(repo_path: String, base: String, head: String) -> Result<models::BranchReviewDiff, String> {
    let dir = local_dir_of(&repo_path)?;
    git::review_diff(&dir.to_string_lossy(), &base, &head).map_err(|e| e.to_string())
}

/// 合并执行（merge / squash / rebase）。返回合并后 base 的顶点 oid。
#[tauri::command]
fn branch_merge(repo_path: String, base: String, head: String, method: String) -> Result<String, String> {
    let method = MergeMethod::parse(&method).map_err(|e| e.to_string())?;
    let m = match method {
        MergeMethod::Merge => "merge",
        MergeMethod::Squash => "squash",
        MergeMethod::Rebase => "rebase",
    };
    let dir = local_dir_of(&repo_path)?;
    git::review_merge(&dir.to_string_lossy(), &base, &head, m).map_err(|e| e.to_string())
}

#[tauri::command]
fn branch_delete(repo_path: String, name: String, force: bool) -> Result<(), String> {
    let dir = local_dir_of(&repo_path)?;
    git::branch_delete(&dir.to_string_lossy(), &name, force).map_err(|e| e.to_string())
}

/// All recorded sync timestamps for the status bar's "last updated" cell.
#[tauri::command]
fn list_synced_at(repo_path: String) -> Result<Vec<(String, String)>, String> {
    let conn = storage::open(&storage_dir_for_target(&repo_path)).map_err(|e| e.to_string())?;
    storage::list_synced(&conn).map_err(|e| e.to_string())
}

/// User-initiated connectivity probe. Ok => online; the raw error string
/// lets the frontend classify network failures (offline) from auth ones.
#[tauri::command]
fn probe_network() -> Result<(), String> {
    gh::probe_network().map_err(|e| e.to_string())
}

/// Read an entity's comments from the offline cache (cache-first rendering).
/// number 统一文本口径（Gitee issue 编号是字符串；PR 由前端转十进制文本）。
#[tauri::command]
fn list_cached_comments(
    repo_path: String,
    kind: String,
    number: String,
) -> Result<Vec<Comment>, String> {
    let kind = Kind::parse(&kind).map_err(|e| e.to_string())?;
    let conn = storage::open(&storage_dir_for_target(&repo_path)).map_err(|e| e.to_string())?;
    storage::list_comments(&conn, kind.as_str(), &number).map_err(|e| e.to_string())
}

/// Fetch an entity's comments via gh, replace the cache slice, return fresh.
#[tauri::command]
fn fetch_comments(repo_path: String, kind: String, number: String) -> Result<Vec<Comment>, String> {
    let kind = Kind::parse(&kind).map_err(|e| e.to_string())?;
    let repo = resolve(&repo_path)?;
    let comments = source::source_for_ref(repo.platform.as_deref(), &repo.host).fetch_comments(&repo, kind, &number).map_err(|e| e.to_string())?;
    let mut conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
    storage::replace_comments(&mut conn, kind.as_str(), &number, &comments).map_err(|e| e.to_string())?;
    Ok(comments)
}

/// Post a comment via gh and return the fresh conversation (write-through).
#[tauri::command]
fn add_comment(
    repo_path: String,
    kind: String,
    number: String,
    body: String,
) -> Result<Vec<Comment>, String> {
    let kind = Kind::parse(&kind).map_err(|e| e.to_string())?;
    let repo = resolve(&repo_path)?;
    let comments = source::source_for_ref(repo.platform.as_deref(), &repo.host).add_comment(&repo, kind, &number, &body).map_err(|e| e.to_string())?;
    let mut conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
    storage::replace_comments(&mut conn, kind.as_str(), &number, &comments).map_err(|e| e.to_string())?;
    Ok(comments)
}

/// Create an issue——按来源分派：本地仓库走 journal `issue.create` +
/// SQLite 双写（编号 meta 水位分配）；远端走 Source 写穿透（gh issue
/// create / REST POST），响应实体回填缓存。
#[tauri::command]
fn create_issue(repo_path: String, title: String, body: Option<String>) -> Result<Issue, String> {
    let repo = resolve(&repo_path)?;
    let issue = match repo.platform.as_deref() {
        Some("local") => {
            let workdir = repo
                .workdir
                .clone()
                .ok_or_else(|| "本地仓库缺少工作目录".to_string())?;
            let mut conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
            journal::sync(&workdir, &mut conn).map_err(|e| e.to_string())?;
            let author = journal::current_author(&workdir);
            journal::create_issue(&workdir, &mut conn, &title, body.as_deref(), &author)
                .map_err(|e| e.to_string())?
        }
        _ => {
            let issue = source::source_for_ref(repo.platform.as_deref(), &repo.host)
                .create_issue(&repo, &title, body.as_deref())
                .map_err(|e| e.to_string())?;
            let conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
            storage::upsert_issue(&conn, &issue, &issue_state_source(&repo)).map_err(|e| e.to_string())?;
            issue
        }
    };
    Ok(issue)
}

/// 缓存 data_source 口径（与 storage 列一致：本地 local，其余按平台）。
fn issue_state_source(repo: &source::RepoRef) -> String {
    repo.platform.clone().unwrap_or_else(|| "github".to_string())
}

/// Create a pull request（远端来源；head/base 为远端分支名）。
#[tauri::command]
fn create_pull(
    repo_path: String,
    head: String,
    base: String,
    title: String,
    body: Option<String>,
) -> Result<Pull, String> {
    let repo = resolve(&repo_path)?;
    if repo.platform.as_deref() == Some("local") {
        return Err("本地仓库没有 PR——分支即 PR，走本地分支 review".to_string());
    }
    let pull = source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .create_pull(&repo, &head, &base, &title, body.as_deref())
        .map_err(|e| e.to_string())?;
    let conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
    storage::upsert_pull(&conn, &pull).map_err(|e| e.to_string())?;
    Ok(pull)
}

/// 远端分支名清单（PR 创建表单 head/base 候选；本地 = 本地分支）。
#[tauri::command]
fn remote_branch_list(repo_path: String) -> Result<Vec<String>, String> {
    let repo = resolve(&repo_path)?;
    source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .remote_branches(&repo)
        .map_err(|e| e.to_string())
}

/// Close or reopen an issue; patches the cache row and returns the fresh
/// entity so the frontend can patch both stores from one source of truth.
/// 尾部挂「关闭→Done」看板自动化（本地/远端关闭都流经此处）。
#[tauri::command]
fn set_issue_state(repo_path: String, number: String, closed: bool) -> Result<Issue, String> {
    let repo = resolve(&repo_path)?;
    let issue = source::source_for_ref(repo.platform.as_deref(), &repo.host).set_issue_state(&repo, &number, closed).map_err(|e| e.to_string())?;
    let conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
    storage::update_issue_state(&conn, &issue.number, &issue.state).map_err(|e| e.to_string())?;
    if closed {
        if let Ok(app) = appdb::open() {
            if let Some((_, _, _)) = appdb::repo_find_by_target(&repo_path) {
                // 条目按登记 repo id 关联；解析失败的仓库（未登记）没有条目
                if let Some(rid) = app_repo_id(&repo_path) {
                    let _ = projects::on_issue_closed_in(&app, &rid, &issue.number);
                }
            }
        }
    }
    Ok(issue)
}

/// 登记表 repo id（看板条目关联键）；未登记 → None。
fn app_repo_id(target: &str) -> Option<String> {
    let conn = appdb::open().ok()?;
    conn.query_row("SELECT id FROM repos WHERE path = ?1 OR remote_url = ?1", (target,), |row| row.get(0))
        .ok()
}

/// 线上仓库清单（「刷新从线上查找」）：按接入的 platform 分派——
/// GitHub 透传 gh 托管账户，Gitea/Gitee 用钥匙串 token 调 /user/repos。
#[tauri::command]
fn remote_repo_list(platform: String, host: String) -> Result<Vec<source::RemoteRepoInfo>, String> {
    match platform.as_str() {
        "github" => gh::list_user_repos(100).map_err(|e| e.to_string()),
        "gitea" | "gitee" => {
            let token = source::keyring_token(&platform);
            gitea::list_user_repos(&platform, &host, token).map_err(|e| e.to_string())
        }
        other => Err(format!("平台 {other} 暂不支持线上清单")),
    }
}

/// 草稿卡转本地 Issue：先走既有 create_issue 通道（目标仓库本地库），
/// 再把条目改为 issue 关联。两步无跨库事务——第二步失败时 Issue 已建，
/// 草稿保留为对账锚（按 uuid 重试不重复建）。
#[tauri::command]
fn convert_draft_to_issue(item_id: String, repo_path: String) -> Result<projects::ProjectItem, String> {
    // 1. 读草稿（必须 draft 形态）
    let app = appdb::open().map_err(|e| e.to_string())?;
    let item = projects::item_get_in(&app, &item_id)?;
    if item.kind != "draft" {
        return Err("只有草稿卡能转为 Issue".to_string());
    }
    let title = item.draft_title.clone().ok_or("草稿缺少标题")?;
    let body = item.draft_body.clone();
    // 2. 目标仓库必须是已登记的本地仓库
    let rid = app_repo_id(&repo_path).ok_or("目标仓库未登记，请先在切换仓库中登记")?;
    let repo = resolve(&repo_path)?;
    if repo.platform.as_deref() != Some("local") {
        return Err("v1 草稿只能转为本地 Issue（目标仓库需无 remote）".to_string());
    }
    let workdir = repo.workdir.clone().ok_or("本地仓库缺少工作目录")?;
    // 3. 仓库侧创建（journal + SQLite）
    let mut conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
    journal::sync(&workdir, &mut conn).map_err(|e| e.to_string())?;
    let author = journal::current_author(&workdir);
    let issue = journal::create_issue(&workdir, &mut conn, &title, body.as_deref(), &author)
        .map_err(|e| e.to_string())?;
    // 4. 条目改关联（字段值/排序原位保留）
    let n = app
        .execute(
            "UPDATE project_items SET kind = 'issue', repo_id = ?2, number = ?3,
                draft_title = NULL, draft_body = NULL WHERE id = ?1",
            rusqlite::params![item_id, rid, issue.number],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("条目更新失败".to_string());
    }
    projects::item_get_in(&app, &item_id)
}

/// Close or reopen a pull request; upserts the fresh full record.
#[tauri::command]
fn set_pull_state(repo_path: String, number: i64, closed: bool) -> Result<Pull, String> {
    let repo = resolve(&repo_path)?;
    let pull = source::source_for_ref(repo.platform.as_deref(), &repo.host).set_pull_state(&repo, &number.to_string(), closed).map_err(|e| e.to_string())?;
    let conn = storage::open(&storage_dir_of(&repo)).map_err(|e| e.to_string())?;
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
            gh_device_flow_start,
            gh_device_flow_poll,
            gh_auth_with_token,
            gh_auth_user,
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
            create_issue,
            create_pull,
            remote_branch_list,
            set_issue_state,
            projects::project_create,
            projects::project_list,
            projects::project_update,
            projects::project_archive,
            projects::project_delete,
            projects::project_fields,
            projects::project_field_set_options,
            projects::project_item_add,
            projects::project_item_list,
            projects::project_item_move,
            projects::project_item_remove,
            projects::project_item_update_draft,
            projects::project_field_value_set,
            projects::project_repo_bind,
            projects::project_repo_unbind,
            projects::project_repo_list,
            remote_repo_list,
            convert_draft_to_issue,
            set_pull_state,
            list_synced_at,
            probe_network,
            merge_pull,
            log_line,
            git_history,
            git_branches,
            git_fetch,
            branch_review_list,
            branch_review_diff,
            branch_merge,
            branch_delete,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            credentials::credential_set,
            credentials::credential_get,
            credentials::credential_delete,
            appdb::connection_list,
            appdb::connection_save,
            appdb::connection_delete,
            appdb::repo_list,
            appdb::repo_register,
            appdb::repo_register_remote,
            appdb::repo_visibility,
            appdb::repo_delete
        ])
        .manage(pty::PtyMap(std::sync::Mutex::new(std::collections::HashMap::new())))
        .run(tauri::generate_context!())
        .expect("error while running HiveTask");
}
