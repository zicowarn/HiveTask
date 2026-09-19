//! Tauri command surface — the bridge between the Vue workbench and the
//! local core (gh CLI + SQLite cache). This same core will later back the
//! headless MCP server from Phase 4.

mod appdb;
mod calendar;
mod credentials;
mod gh;
mod gitea;
mod git;
mod journal;
mod kb;
mod kb_watch;
mod openwith_apps;
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

/// 缓存/索引类命令的仓库根：本地克隆 → 工作区本身；仅远端 →
/// app data 的 repos-cache/<owner>/<repo>/（合成仓库目录，journal 引用
/// 住它的 .git；SQLite 索引在 app data 的 repo-index/，见 storage.rs）。
/// 缓存命令的容错版：target 无法解析（非 git 目录）时退到 temp 隔离目录，
/// 让缓存读写降级为空集而不是报错。
fn repo_root_for_target(target: &str) -> PathBuf {
    source::resolve_target(target)
        .map(|r| repo_root_of(&r))
        .unwrap_or_else(|_| std::env::temp_dir().join("hivetask-orphan").join(target.replace('/', "_")))
}

/// 传给 storage::open 的是仓库根本身——索引不再写进仓库（历史布局
/// `<repo>/.hivetask/` 由 storage 首次 open 时自动迁出）。
fn repo_root_of(repo: &source::RepoRef) -> PathBuf {
    if let Some(workdir) = &repo.workdir {
        return workdir.clone();
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
/// 另存文本（视图数据 CSV 导出用）：原生保存对话框 → 写文件；取消返回 None。
#[tauri::command]
async fn save_text_file(
    window: tauri::WebviewWindow,
    default_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::FilePath;

    let (tx, mut rx) = tauri::async_runtime::channel::<Option<String>>(1);
    window
        .dialog()
        .file()
        .set_title("导出为 CSV")
        .set_file_name(&default_name)
        .save_file(move |path| {
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
    let Some(path) = rx.recv().await.ok_or_else(|| "对话框已关闭".to_string())? else {
        return Ok(None); // 用户取消
    };
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(Some(path))
}

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
    let mut conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
    storage::replace_issues(&mut conn, &state, &issues).map_err(|e| e.to_string())?;
    storage::stamp_synced(&conn, &format!("synced:issues:{state}")).map_err(|e| e.to_string())?;
    Ok(issues)
}

/// Read issues from the offline cache without touching the network.
#[tauri::command]
fn list_cached_issues(repo_path: String, state: String) -> Result<Vec<Issue>, String> {
    let conn = storage::open(&repo_root_for_target(&repo_path)).map_err(|e| e.to_string())?;
    storage::list_issues(&conn, &state).map_err(|e| e.to_string())
}

#[tauri::command]
fn cached_issue_count(repo_path: String, state: String) -> Result<i64, String> {
    let conn = storage::open(&repo_root_for_target(&repo_path)).map_err(|e| e.to_string())?;
    storage::cached_issue_count(&conn, &state).map_err(|e| e.to_string())
}

/// Fetch pull requests via gh, replace the local cache, return fresh data.
/// `state` is "open" | "closed" | "merged" | "all".
#[tauri::command]
fn refresh_pulls(repo_path: String, state: String, limit: u32) -> Result<Vec<Pull>, String> {
    let repo = resolve(&repo_path)?;
    let filter = PullStateFilter::parse(&state).map_err(|e| e.to_string())?;
    let pulls = source::source_for_ref(repo.platform.as_deref(), &repo.host).fetch_pulls(&repo, filter, limit).map_err(|e| e.to_string())?;
    let mut conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
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
    let conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
    storage::upsert_pull(&conn, &pull).map_err(|e| e.to_string())?;
    Ok(pull)
}

/// Read PRs from the offline cache without touching the network.
#[tauri::command]
fn list_cached_pulls(repo_path: String, state: String) -> Result<Vec<Pull>, String> {
    let conn = storage::open(&repo_root_for_target(&repo_path)).map_err(|e| e.to_string())?;
    storage::list_pulls(&conn, &state).map_err(|e| e.to_string())
}

#[tauri::command]
fn cached_pull_count(repo_path: String, state: String) -> Result<i64, String> {
    let conn = storage::open(&repo_root_for_target(&repo_path)).map_err(|e| e.to_string())?;
    storage::cached_pull_count(&conn, &state).map_err(|e| e.to_string())
}

/// Merge a pull request; upserts the fresh full record and returns it.
#[tauri::command]
fn merge_pull(repo_path: String, number: i64, method: String) -> Result<Pull, String> {
    let method = MergeMethod::parse(&method).map_err(|e| e.to_string())?;
    let repo = resolve(&repo_path)?;
    let pull = source::source_for_ref(repo.platform.as_deref(), &repo.host).merge_pull(&repo, &number.to_string(), method).map_err(|e| e.to_string())?;
    let conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
    storage::upsert_pull(&conn, &pull).map_err(|e| e.to_string())?;
    Ok(pull)
}

/// Commit history across all local + remote tips, for the graph renderer.
#[tauri::command]
fn git_history(repo_path: String, limit: Option<u32>) -> Result<models::GitHistoryPage, String> {
    let dir = local_dir_of(&repo_path)?;
    git::history(&dir.to_string_lossy(), limit).map_err(|e| e.to_string())
}

/// 知识库侧入口：**知识库根**可能只是仓库的一个子目录（甚至就是仓库根），
/// 所以这里把"根 + 相对根的路径"换算成"仓库 + 仓库内相对路径"，再查单文件历史。
#[tauri::command]
fn git_file_history(root: String, rel: String, limit: Option<u32>) -> Result<models::GitHistoryPage, String> {
    let repo = git2::Repository::discover(&root).map_err(|e| e.to_string())?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| "裸仓库没有工作区".to_string())?
        .to_path_buf();
    let rel_in_repo = std::path::Path::new(&root)
        .join(&rel)
        .strip_prefix(&workdir)
        .map_err(|_| "文件不在该 Git 仓库内".to_string())?
        .to_string_lossy()
        .to_string();
    git::file_history(&workdir.to_string_lossy(), &rel_in_repo, limit).map_err(|e| e.to_string())
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

/// 日历面板「提交热力」图层：HEAD + 本地分支的每日提交计数（窗口天数）。
#[tauri::command]
fn git_commit_activity(repo_path: String, days: Option<u32>) -> Result<Vec<models::CommitDayCount>, String> {
    let dir = local_dir_of(&repo_path)?;
    git::commit_activity(&dir.to_string_lossy(), days.unwrap_or(365)).map_err(|e| e.to_string())
}

// ---- 日历 S3-b：ICS 订阅 / 内置法定假日 / 农历副行（calendar.rs）----

#[tauri::command]
fn calendar_feed_list() -> Result<Vec<calendar::FeedRow>, String> {
    calendar::feed_list().map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_feed_add(name: String, url: String) -> Result<calendar::FeedRow, String> {
    calendar::feed_add(&name, &url).map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_feed_remove(id: String) -> Result<(), String> {
    calendar::feed_remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_feed_set_enabled(id: String, enabled: bool) -> Result<calendar::FeedRow, String> {
    calendar::feed_set_enabled(&id, enabled).map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_feed_set_color(id: String, color: Option<String>) -> Result<calendar::FeedRow, String> {
    calendar::feed_set_color(&id, color).map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_feed_sync(id: String) -> Result<u32, String> {
    calendar::feed_sync(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_feed_events() -> Result<Vec<calendar::FeedEvent>, String> {
    calendar::feed_events().map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_lunar_range(start: String, end: String) -> Result<Vec<calendar::LunarLabel>, String> {
    calendar::lunar_range(&start, &end).map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_lunar_ymd(date: String) -> Result<calendar::LunarYmd, String> {
    calendar::lunar_ymd(&date).map_err(|e| e.to_string())
}

// ---- 日历 S4：日程（calendar_events）----

#[tauri::command]
fn calendar_event_list() -> Result<Vec<calendar::EventRow>, String> {
    calendar::event_list().map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_event_create(
    title: String,
    start_date: String,
    end_date: Option<String>,
    all_day: bool,
    start_time: Option<String>,
    end_time: Option<String>,
    notes: Option<String>,
    remind_at: Option<String>,
    recur: String,
) -> Result<calendar::EventRow, String> {
    calendar::event_create(
        &title,
        &start_date,
        end_date,
        all_day,
        start_time,
        end_time,
        notes,
        remind_at,
        recur,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_event_update(
    id: String,
    title: String,
    start_date: String,
    end_date: Option<String>,
    all_day: bool,
    start_time: Option<String>,
    end_time: Option<String>,
    notes: Option<String>,
    remind_at: Option<String>,
    recur: String,
) -> Result<calendar::EventRow, String> {
    calendar::event_update(
        &id,
        &title,
        &start_date,
        end_date,
        all_day,
        start_time,
        end_time,
        notes,
        remind_at,
        recur,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_event_remove(id: String) -> Result<(), String> {
    calendar::event_remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn calendar_event_set_reminded(id: String, reminded_at: Option<String>) -> Result<calendar::EventRow, String> {
    calendar::event_set_reminded(&id, reminded_at).map_err(|e| e.to_string())
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

/// PR 创建预览：base..head 提交清单（本地分支优先，origin/{name} 兜底）。
#[tauri::command]
fn pr_commits_between(repo_path: String, base: String, head: String) -> Result<Vec<models::CommitRow>, String> {
    let dir = local_dir_of(&repo_path)?;
    git::commits_between(&dir.to_string_lossy(), &base, &head).map_err(|e| e.to_string())
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
    let conn = storage::open(&repo_root_for_target(&repo_path)).map_err(|e| e.to_string())?;
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
    let conn = storage::open(&repo_root_for_target(&repo_path)).map_err(|e| e.to_string())?;
    storage::list_comments(&conn, kind.as_str(), &number).map_err(|e| e.to_string())
}

/// Fetch an entity's comments via gh, replace the cache slice, return fresh.
#[tauri::command]
fn fetch_comments(repo_path: String, kind: String, number: String) -> Result<Vec<Comment>, String> {
    let kind = Kind::parse(&kind).map_err(|e| e.to_string())?;
    let repo = resolve(&repo_path)?;
    let comments = source::source_for_ref(repo.platform.as_deref(), &repo.host).fetch_comments(&repo, kind, &number).map_err(|e| e.to_string())?;
    let mut conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
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
    let mut conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
    storage::replace_comments(&mut conn, kind.as_str(), &number, &comments).map_err(|e| e.to_string())?;
    Ok(comments)
}

/// Create an issue——按来源分派：本地仓库走 journal `issue.create` +
/// SQLite 双写（编号 meta 水位分配）；远端走 Source 写穿透（gh issue
/// create / REST POST），响应实体回填缓存。
#[tauri::command]
fn create_issue(
    repo_path: String,
    title: String,
    body: Option<String>,
    milestone: Option<String>,
    labels: Option<Vec<String>>,
    assignees: Option<Vec<String>>,
) -> Result<Issue, String> {
    let labels = labels.unwrap_or_default();
    let assignees = assignees.unwrap_or_default();
    let repo = resolve(&repo_path)?;
    let issue = match repo.platform.as_deref() {
        Some("local") => {
            let workdir = repo
                .workdir
                .clone()
                .ok_or_else(|| "本地仓库缺少工作目录".to_string())?;
            let mut conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
            journal::sync(&workdir, &mut conn).map_err(|e| e.to_string())?;
            let author = journal::current_author(&workdir);
            journal::create_issue(&workdir, &mut conn, &title, body.as_deref(), &author, milestone.as_deref())
                .map_err(|e| e.to_string())?
        }
        _ => {
            let issue = source::source_for_ref(repo.platform.as_deref(), &repo.host)
                .create_issue(&repo, &title, body.as_deref(), milestone.as_deref(), &labels, &assignees)
                .map_err(|e| e.to_string())?;
            let conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
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

/// 创建里程碑本体（远端来源；返回平台确认的名称）。
#[tauri::command]
fn create_milestone(
    repo_path: String,
    title: String,
    due_on: Option<String>,
    description: Option<String>,
) -> Result<String, String> {
    let repo = resolve(&repo_path)?;
    source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .create_milestone(&repo, &title, due_on.as_deref(), description.as_deref())
        .map_err(|e| e.to_string())
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
    let conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
    storage::upsert_pull(&conn, &pull).map_err(|e| e.to_string())?;
    Ok(pull)
}

/// 里程碑元数据清单（组头 Due by / Overdue 的数据源）。
#[tauri::command]
fn milestone_list(repo_path: String) -> Result<Vec<models::MilestoneInfo>, String> {
    let repo = resolve(&repo_path)?;
    source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .list_milestones(&repo)
        .map_err(|e| e.to_string())
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
fn set_issue_state(
    repo_path: String,
    number: String,
    closed: bool,
    reason: Option<String>,
) -> Result<Issue, String> {
    let repo = resolve(&repo_path)?;
    let issue = source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .set_issue_state(&repo, &number, closed, reason.as_deref())
        .map_err(|e| e.to_string())?;
    let conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
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

/// 锁定/解锁讨论（gh/Gitea；本地 Err）。
#[tauri::command]
fn issue_set_locked(repo_path: String, number: String, locked: bool) -> Result<(), String> {
    let repo = resolve(&repo_path)?;
    source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .set_issue_locked(&repo, &number, locked)
        .map_err(|e| e.to_string())
}

/// 删除 Issue（平台侧永久删除，需管理员；Gitea/本地 Err）。
#[tauri::command]
fn issue_delete(repo_path: String, number: String) -> Result<(), String> {
    let repo = resolve(&repo_path)?;
    source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .delete_issue(&repo, &number)
        .map_err(|e| e.to_string())
}

/// 仓库标签清单（创建 Issue 对话框侧栏候选）。
#[tauri::command]
fn label_list(repo_path: String) -> Result<Vec<models::LabelInfo>, String> {
    let repo = resolve(&repo_path)?;
    source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .list_labels(&repo)
        .map_err(|e| e.to_string())
}

/// 可指派用户清单（创建 Issue 对话框侧栏候选）。
#[tauri::command]
fn assignee_list(repo_path: String) -> Result<Vec<String>, String> {
    let repo = resolve(&repo_path)?;
    source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .list_assignees(&repo)
        .map_err(|e| e.to_string())
}

/// 新建仓库标签（写穿透，返回平台确认的标签）。
#[tauri::command]
fn create_label(repo_path: String, name: String, color: String) -> Result<models::LabelInfo, String> {
    let repo = resolve(&repo_path)?;
    source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .create_label(&repo, &name, &color)
        .map_err(|e| e.to_string())
}

/// 切换里程碑开启/关闭（Source 写穿透 → 定点替换返回元数据）。
#[tauri::command]
fn set_milestone_state(
    repo_path: String,
    number: i64,
    closed: bool,
) -> Result<models::MilestoneInfo, String> {
    let repo = resolve(&repo_path)?;
    source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .set_milestone_state(&repo, number, closed)
        .map_err(|e| e.to_string())
}

/// 编辑里程碑名称/描述/截止日（Source 写穿透）。
#[tauri::command]
fn update_milestone(
    repo_path: String,
    number: i64,
    title: String,
    description: Option<String>,
    due_on: Option<String>,
) -> Result<models::MilestoneInfo, String> {
    let repo = resolve(&repo_path)?;
    source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .update_milestone(&repo, number, &title, description.as_deref(), due_on.as_deref())
        .map_err(|e| e.to_string())
}

/// 编辑 Issue 标题/正文（Source 写穿透 → 定点回写物化视图）。
#[tauri::command]
fn update_issue(
    repo_path: String,
    number: String,
    title: String,
    body: Option<String>,
) -> Result<Issue, String> {
    let repo = resolve(&repo_path)?;
    let issue = source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .update_issue(&repo, &number, &title, body.as_deref())
        .map_err(|e| e.to_string())?;
    let conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE issues SET title = ?1, body = ?2, synced_at = datetime('now') WHERE number = ?3",
        (issue.title.clone(), issue.body.clone(), issue.number.clone()),
    )
    .map_err(|e| e.to_string())?;
    Ok(issue)
}

/// 挂/清里程碑（写穿透 → 缓存行同步）。
#[tauri::command]
fn issue_update_milestone(
    repo_path: String,
    number: String,
    milestone: Option<String>,
) -> Result<Issue, String> {
    let repo = resolve(&repo_path)?;
    let issue = source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .update_issue_milestone(&repo, &number, milestone.as_deref())
        .map_err(|e| e.to_string())?;
    let conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE issues SET milestone = ?1, synced_at = datetime('now') WHERE number = ?2",
        (issue.milestone.clone(), issue.number.clone()),
    )
    .map_err(|e| e.to_string())?;
    Ok(issue)
}

/// 整体替换标签（写穿透 → 缓存行同步）。
#[tauri::command]
fn issue_update_labels(repo_path: String, number: String, labels: Vec<String>) -> Result<Issue, String> {
    let repo = resolve(&repo_path)?;
    let issue = source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .update_issue_labels(&repo, &number, &labels)
        .map_err(|e| e.to_string())?;
    let conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE issues SET labels = ?1, synced_at = datetime('now') WHERE number = ?2",
        (
            serde_json::json!(issue.labels).to_string(),
            issue.number.clone(),
        ),
    )
    .map_err(|e| e.to_string())?;
    Ok(issue)
}

/// 整体替换负责人（写穿透 → 缓存行同步）。
#[tauri::command]
fn issue_update_assignees(
    repo_path: String,
    number: String,
    assignees: Vec<String>,
) -> Result<Issue, String> {
    let repo = resolve(&repo_path)?;
    let issue = source::source_for_ref(repo.platform.as_deref(), &repo.host)
        .update_issue_assignees(&repo, &number, &assignees)
        .map_err(|e| e.to_string())?;
    let conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE issues SET assignees = ?1, synced_at = datetime('now') WHERE number = ?2",
        (
            serde_json::json!(issue.assignees).to_string(),
            issue.number.clone(),
        ),
    )
    .map_err(|e| e.to_string())?;
    Ok(issue)
}

/// 登记表 repo id（看板条目关联键）；未登记 → None。
fn app_repo_id(target: &str) -> Option<String> {
    let conn = appdb::open().ok()?;
    conn.query_row("SELECT id FROM repos WHERE path = ?1 OR remote_url = ?1", (target,), |row| row.get(0))
        .ok()
}

/// 线上 ProjectsV2 清单（GitHub；viewer 名下，按最近更新排序）。
/// 需 gh token 具备 read:project scope——缺失时透传可读指引。
#[tauri::command]
fn remote_project_list(limit: Option<u32>) -> Result<Vec<gh::RemoteProject>, String> {
    gh::list_user_projects(limit.unwrap_or(50)).map_err(|e| e.to_string())
}

/// 线上仓库清单（「刷新从线上查找」）：按接入的 platform 分派——
/// GitHub 透传 gh 托管账户，Gitea/Gitee 用钥匙串 token 调 /user/repos。

/// 拉取线上 ProjectsV2 条目落本地看板（需 read:project；仅 GitHub 项目）。
/// 返回 { imported, skipped }：未登记仓库的条目跳过（不静默登记）。
/// 平台色名 → 十六进制（与 Edit option 对话框的八色调色板一致）。
fn gh_color_hex(name: &str) -> &'static str {
    match name.to_ascii_uppercase().as_str() {
        "BLUE" => "#0969da",
        "GREEN" => "#1a7f37",
        "YELLOW" => "#9a6700",
        "ORANGE" => "#bc4c00",
        "RED" => "#d1242f",
        "PINK" => "#bf3989",
        "PURPLE" => "#8250df",
        _ => "#59636e", // GRAY
    }
}

/// 本地十六进制色 → 平台色名（`gh_color_hex` 的反向；发布列时用）。
/// 八色调色板以外的本地色（自建列取色器）就近归一到最接近的色名。
fn gh_color_name(hex: &str) -> &'static str {
    let h = hex.trim().trim_start_matches('#').to_ascii_lowercase();
    let mapped = match h.as_str() {
        "0969da" => "BLUE",
        "1a7f37" => "GREEN",
        "9a6700" => "YELLOW",
        "bc4c00" => "ORANGE",
        "d1242f" => "RED",
        "bf3989" => "PINK",
        "8250df" => "PURPLE",
        "59636e" => "GRAY",
        _ => "",
    };
    if !mapped.is_empty() {
        return mapped;
    }
    // 非调色板颜色：按 RGB 距离归一到八色里最接近的一档
    let parse = |i: usize| u8::from_str_radix(h.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0) as i32;
    let (r, g, b) = (parse(0), parse(2), parse(4));
    [
        ("BLUE", "#0969da"),
        ("GREEN", "#1a7f37"),
        ("YELLOW", "#9a6700"),
        ("ORANGE", "#bc4c00"),
        ("RED", "#d1242f"),
        ("PINK", "#bf3989"),
        ("PURPLE", "#8250df"),
        ("GRAY", "#59636e"),
    ]
    .iter()
    .map(|(name, ref_hex)| {
        let p = |i: usize| i32::from_str_radix(&ref_hex[1 + i..1 + i + 2], 16).unwrap_or(0);
        let d = (r - p(0)).pow(2) + (g - p(2)).pow(2) + (b - p(4)).pow(2);
        (*name, d)
    })
    .min_by_key(|(_, d)| *d)
    .map(|(n, _)| n)
    .unwrap_or("GRAY")
}

#[cfg(test)]
mod sync_tests {
    use super::{gh_color_hex, gh_color_name};

    /// 平台色名 → 十六进制：与 Edit option 八色调色板一致；未知回落 GRAY。
    #[test]
    fn color_map_matches_palette() {
        assert_eq!(gh_color_hex("PURPLE"), "#8250df");
        assert_eq!(gh_color_hex("blue"), "#0969da");
        assert_eq!(gh_color_hex("ORANGE"), "#bc4c00");
        assert_eq!(gh_color_hex("WHATEVER"), "#59636e");
    }

    /// 线上独有字段的建列排除表（GitHub 内置字段不该变成本地列）。
    #[test]
    fn builtin_fields_are_excluded() {
        use super::GH_BUILTIN_FIELDS;
        for name in ["Title", "Assignees", "Labels", "Milestone", "Repository", "Sub-issues progress"] {
            assert!(
                GH_BUILTIN_FIELDS.iter().any(|n| n.eq_ignore_ascii_case(name)),
                "{name} 应被排除"
            );
        }
        assert!(!GH_BUILTIN_FIELDS.iter().any(|n| n.eq_ignore_ascii_case("Size")));
    }

    /// 十六进制 → 色名：调色板原样往返；近似色（自建列取色器）归一不错档。
    #[test]
    fn color_name_round_trips_palette() {
        for name in ["BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE", "GRAY"] {
            assert_eq!(gh_color_name(gh_color_hex(name)), name, "{name} 往返应稳定");
        }
        assert_eq!(gh_color_name("#0a6adc"), "BLUE", "近蓝应归一到 BLUE");
        assert_eq!(gh_color_name("d12430"), "RED", "无 # 前缀也应识别（近红→RED）");
    }
}

/// 线上项目引用的三要素：归属类型（user/org）、归属名、项目编号。
/// ref 形如 https://github.com/users/<owner>/projects/<n> 或 /orgs/<owner>/projects/<n>。
fn parse_project_ref(r#ref: &str) -> Result<(String, String, u32), String> {
    let parts: Vec<&str> = r#ref.trim_end_matches('/').split('/').collect();
    let idx = parts
        .iter()
        .position(|p| *p == "users" || *p == "orgs")
        .ok_or_else(|| "无法解析线上项目地址".to_string())?;
    let owner_kind = if parts[idx] == "orgs" { "org" } else { "user" };
    let owner = *parts.get(idx + 1).ok_or_else(|| "无法解析项目归属".to_string())?;
    let number: u32 = *parts
        .last()
        .and_then(|n| n.parse::<u32>().ok())
        .as_ref()
        .ok_or_else(|| "无法解析项目编号".to_string())?;
    Ok((owner_kind.to_string(), owner.to_string(), number))
}

/// GitHub 内置字段（非用户列）：本地不建模，刷新时不据此建列。
const GH_BUILTIN_FIELDS: [&str; 12] = [
    "Title",
    "Assignees",
    "Labels",
    "Milestone",
    "Repository",
    "Parent issue",
    "Sub-issues progress",
    "Linked pull requests",
    "Reviewers",
    "Tracks",
    "Tracked by",
    "Pull requests",
];

/// 本地字段名 → 线上字段名（两个同名不改的字段除外：状态 → Status、优先级 → Priority）。
fn online_field_name(field: &projects::ProjectField) -> &str {
    if field.kind == "builtin_status" {
        "Status"
    } else if field.name == "优先级" {
        "Priority"
    } else {
        &field.name
    }
}

/// 线上一组选项 → 本地 FieldOption（同名保留本地 id，新名派生稳定 id）。
fn map_remote_options(field_id: &str, local: Option<&Vec<projects::FieldOption>>, remote: &[gh::RemoteFieldOption]) -> Vec<projects::FieldOption> {
    remote
        .iter()
        .map(|o| {
            let existing = local.and_then(|ls| ls.iter().find(|x| x.name.eq_ignore_ascii_case(&o.name)));
            projects::FieldOption {
                id: existing
                    .map(|x| x.id.clone())
                    .unwrap_or_else(|| format!("{field_id}-{}", o.name.to_lowercase().replace(' ', "-"))),
                name: o.name.clone(),
                color: gh_color_hex(&o.color).to_string(),
                description: o.description.clone(),
            }
        })
        .collect()
}

#[tauri::command]
fn project_sync_items(project_id: String) -> Result<(u32, u32), String> {
    let app = appdb::open().map_err(|e| e.to_string())?;
    let project = projects::project_get_in(&app, &project_id)?;
    let r#ref = project.platform_ref.clone().ok_or_else(|| "该项目未绑定线上项目".to_string())?;
    let kind = project.platform_kind.clone().unwrap_or_else(|| "github".to_string());
    if kind != "github" {
        return Err("目前仅支持 GitHub Projects 的数据刷新".to_string());
    }
    let (owner_kind, owner, number) = parse_project_ref(&r#ref)?;

    let snap = gh::fetch_project_items(&owner_kind, &owner, number, 100).map_err(|e| e.to_string())?;

    // ---- ① 列设置对齐：线上 Status / Priority 的选项（名称/顺序/颜色/说明）写进本地字段 ----
    for remote_field in &snap.fields {
        // 非单选字段（数字/文本/日期）没有选项表，只需第 ① 步的建列
        if remote_field.options.is_empty() && remote_field.data_type.as_deref() != Some("NUMBER") && remote_field.data_type.as_deref() != Some("TEXT") && remote_field.data_type.as_deref() != Some("DATE") {
            continue;
        }
        let local = projects::fields_in(&app, &project_id)?
            .into_iter()
            .find(|f| {
                (remote_field.name.eq_ignore_ascii_case("status") && f.kind == "builtin_status")
                    || f.name.eq_ignore_ascii_case(&remote_field.name)
                    || (remote_field.name.eq_ignore_ascii_case("priority") && f.name == "优先级")
            });
        let local = match local {
            Some(f) => f,
            None => {
                // 线上独有的字段：本地自动补同名字段，否则这些列的值在卡片上没有落点。
                // 类型随线上（单选给选项表；数字/文本/日期只建壳）。GitHub 内置字段不建。
                if GH_BUILTIN_FIELDS.iter().any(|n| n.eq_ignore_ascii_case(&remote_field.name)) {
                    continue;
                }
                let kind = match remote_field.data_type.as_deref().unwrap_or("SINGLE_SELECT") {
                    "NUMBER" => "number",
                    "TEXT" => "text",
                    "DATE" => "date",
                    "SINGLE_SELECT" => "single_select",
                    _ => continue, // ITERATION / 关联等类型本地不建模
                };
                if kind != "single_select" && remote_field.options.is_empty() {
                    projects::field_create_in(&app, &project_id, &remote_field.name, kind, &[])?;
                    continue;
                }
                let names: Vec<String> = remote_field.options.iter().map(|o| o.name.clone()).collect();
                let created =
                    projects::field_create_in(&app, &project_id, &remote_field.name, "single_select", &names)?;
                projects::field_set_options_in(
                    &app,
                    &created.id,
                    &map_remote_options(&created.id, Some(&created.options), &remote_field.options),
                )?;
                continue;
            }
        };
        // 同名选项保留本地 id（item 既有值不丢）；新名称用线上名派生稳定 id。
        // 线上是列设置的真源：本地独有选项在此被覆盖掉（用户要的「更新即覆盖」）。
        let options = map_remote_options(&local.id, Some(&local.options), &remote_field.options);
        if !options.is_empty() {
            projects::field_set_options_in(&app, &local.id, &options)?;
        }
    }

    let items = snap.items;
    let fields = projects::fields_in(&app, &project_id)?;
    let mut imported = 0u32;
    let mut skipped = 0u32;
    for it in items {
        let (Some(full), Some(num)) = (it.repo_full_name.clone(), it.number) else {
            skipped += 1; // 草稿条目：平台侧草稿，本地无对应实体
            continue;
        };
        let repo_id: Option<String> = app
            .query_row(
                "SELECT id FROM repos WHERE remote_url LIKE '%' || ?1 || '%' ORDER BY last_opened_at DESC LIMIT 1",
                (&full,),
                |row| row.get(0),
            )
            .ok();
        let Some(repo_id) = repo_id else {
            skipped += 1; // 仓库未登记：不静默登记，交由用户在「切换仓库」里处理
            continue;
        };
        let number = num.to_string();
        let existing: Option<String> = app
            .query_row(
                "SELECT id FROM project_items WHERE project_id = ?1 AND kind = 'issue' AND repo_id = ?2 AND number = ?3",
                (&project_id, &repo_id, &number),
                |row| row.get(0),
            )
            .ok();
        let item_id = match existing {
            Some(id) => id,
            None => {
                let created = projects::item_add_in(
                    &app,
                    &project_id,
                    "issue",
                    Some(&repo_id),
                    Some(&number),
                    it.title.as_deref(),
                    None,
                )?;
                imported += 1;
                created.id
            }
        };
        // 字段值按**线上字段名**（含别名）对齐写回：
        // 单选查选项 id（对不上就保持原值），数字/文本/日期存文本。
        for field in fields.iter().filter(|f| {
            matches!(f.kind.as_str(), "builtin_status" | "single_select" | "number" | "text" | "date")
        }) {
            let Some(raw) = it.values.get(online_field_name(field)) else { continue };
            if field.kind == "builtin_status" || field.kind == "single_select" {
                if let Some(opt) = field.options.iter().find(|o| o.name.eq_ignore_ascii_case(raw)) {
                    projects::set_field_value_in(&app, &item_id, &field.id, Some(&opt.id))?;
                }
                continue;
            }
            projects::set_field_value_in(&app, &item_id, &field.id, Some(raw))?;
        }
    }
    app.execute(
        "UPDATE projects SET synced_at = ?2 WHERE id = ?1",
        rusqlite::params![project_id, appdb::chrono_like_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok((imported, skipped))
}

/// 本地列 → 线上：把本地单选字段的选项表（名称/顺序/颜色/说明）整体推到线上项目。
/// 覆盖式写入（updateProjectV2Field 的 singleSelectOptions 是整表替换）。
/// 需要 project 写权限；权限不足时返回可读指引，本地列不受影响。
#[tauri::command]
fn project_publish_columns(project_id: String) -> Result<u32, String> {
    let app = appdb::open().map_err(|e| e.to_string())?;
    let project = projects::project_get_in(&app, &project_id)?;
    let r#ref = project.platform_ref.clone().ok_or_else(|| "该项目未绑定线上项目".to_string())?;
    let kind = project.platform_kind.clone().unwrap_or_else(|| "github".to_string());
    if kind != "github" {
        return Err("目前仅支持发布到 GitHub Projects".to_string());
    }
    let (owner_kind, owner, number) = parse_project_ref(&r#ref)?;
    let fields = projects::fields_in(&app, &project_id)?;
    let mut published = 0u32;
    for field in fields
        .iter()
        .filter(|f| f.kind == "builtin_status" || f.kind == "single_select")
    {
        if field.options.is_empty() {
            continue;
        }
        // 线上字段名：与刷新侧同一套别名（状态→Status、优先级→Priority）
        let online_name = online_field_name(field).to_string();
        let opts: Vec<(String, String, Option<String>)> = field
            .options
            .iter()
            .map(|o| (o.name.clone(), gh_color_name(&o.color).to_string(), o.description.clone()))
            .collect();
        match gh::publish_field_options(&owner_kind, &owner, number, &online_name, &opts) {
            Ok(()) => published += 1,
            // 线上没有该字段（本地自建列）：跳过，不算失败
            Err(e) if e.to_string().contains("没有名为") => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(published)
}

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
    let mut conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
    journal::sync(&workdir, &mut conn).map_err(|e| e.to_string())?;
    let author = journal::current_author(&workdir);
    let issue = journal::create_issue(&workdir, &mut conn, &title, body.as_deref(), &author, None)
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
    let conn = storage::open(&repo_root_of(&repo)).map_err(|e| e.to_string())?;
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            health_check,
            gh_device_flow_start,
            gh_device_flow_poll,
            gh_auth_with_token,
            gh_auth_user,
            pick_repo,
            kb::kb_pick_root,
            kb::kb_list_dir,
            kb::kb_walk,
            kb::kb_search,
            kb::kb_stat,
            kb_watch::kb_watch_start,
            kb_watch::kb_watch_stop,
            kb::kb_thumbnail,
            kb::kb_read_text,
            kb::kb_read_bytes,
            kb::kb_write_text,
            kb::kb_create,
            kb::kb_write_bytes,
            kb::kb_rename,
            kb::kb_copy,
            kb::kb_move,
            kb::kb_delete,
            kb::kb_pick_app,
            openwith_apps::kb_apps_list,
            openwith_apps::kb_apps_for_ext,
            kb::kb_open_prefs_get,
            kb::kb_open_prefs_set,
            kb::kb_open_external,
            save_text_file,
            remote_project_list,
            project_sync_items,
            project_publish_columns,
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
            create_milestone,
            remote_branch_list,
            milestone_list,
            label_list,
            assignee_list,
            create_label,
            set_milestone_state,
            update_milestone,
            set_issue_state,
            issue_set_locked,
            issue_delete,
            update_issue,
            issue_update_milestone,
            issue_update_labels,
            issue_update_assignees,
            projects::project_create,
            projects::project_import_remote,
            projects::project_list,
            projects::project_update,
            projects::project_archive,
            projects::project_delete,
            projects::project_fields,
            projects::project_field_set_options,
            projects::project_field_create,
            projects::project_field_option_add,
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
            git_file_history,
            git_branches,
            git_fetch,
            git_commit_activity,
            calendar_feed_list,
            calendar_feed_add,
            calendar_feed_remove,
            calendar_feed_set_enabled,
            calendar_feed_set_color,
            calendar_feed_sync,
            calendar_feed_events,
            calendar_lunar_range,
            calendar_lunar_ymd,
            calendar_event_list,
            calendar_event_create,
            calendar_event_update,
            calendar_event_remove,
            calendar_event_set_reminded,
            branch_review_list,
            branch_review_diff,
            pr_commits_between,
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

#[cfg(test)]
mod live_sync_tests {
    /// 实机把本地列发布到线上（`cargo test -- --ignored` 手动触发；需要 project 写权限）。
    /// 发布后回读线上选项表，验证「本地改列 → 线上列一致」。
    #[test]
    #[ignore]
    fn publish_real_project_columns_round_trip() {
        let app = crate::appdb::open().expect("打开 app.db");
        let pid: String = app
            .query_row(
                "SELECT id FROM projects WHERE platform_ref LIKE '%users/zicowarn/projects/13%'",
                (),
                |r| r.get(0),
            )
            .expect("本地应有绑定的 PDFRefTrans 项目");
        let published = super::project_publish_columns(pid.clone()).expect("发布应成功");
        eprintln!("发布字段数：{published}");
        let snap = crate::gh::fetch_project_items("user", "zicowarn", 13, 5).expect("回读线上字段");
        let local = crate::projects::fields_in(&app, &pid).expect("读本地字段");
        for lf in local
            .iter()
            .filter(|f| f.kind == "builtin_status" || f.kind == "single_select")
        {
            let online_name = super::online_field_name(lf);
            let Some(rf) = snap.fields.iter().find(|f| f.name == online_name) else { continue };
            let local_names: Vec<&str> = lf.options.iter().map(|o| o.name.as_str()).collect();
            let online_names: Vec<&str> = rf.options.iter().map(|o| o.name.as_str()).collect();
            eprintln!("{online_name}: 本地 {local_names:?} / 线上 {online_names:?}");
            assert_eq!(local_names, online_names, "{online_name} 的列应与本地一致");
        }
    }

    /// 实机对线上项目跑一次同步（网络 + 真实 app.db）：`cargo test -- --ignored` 手动触发。
    /// 验证「线上独有的单选字段自动补成本地列」与「选项按线上覆盖」两条路径。
    #[test]
    #[ignore]
    fn sync_real_project_pulls_online_columns() {
        let app = crate::appdb::open().expect("打开 app.db");
        let pid: String = app
            .query_row(
                "SELECT id FROM projects WHERE platform_ref LIKE '%users/zicowarn/projects/13%'",
                (),
                |r| r.get(0),
            )
            .expect("本地应有绑定的 PDFRefTrans 项目");
        let (imported, skipped) = super::project_sync_items(pid.clone()).expect("同步应成功");
        eprintln!("导入 {imported} 条，跳过 {skipped} 条");
        let fields = crate::projects::fields_in(&app, &pid).expect("读字段");
        let names: Vec<&str> = fields.iter().map(|f| f.name.as_str()).collect();
        eprintln!("本地字段：{names:?}");
        assert!(names.contains(&"Size"), "线上 Size 应补成本地列：{names:?}");
        let size = fields.iter().find(|f| f.name == "Size").unwrap();
        let opt_names: Vec<&str> = size.options.iter().map(|o| o.name.as_str()).collect();
        eprintln!("Size 选项：{opt_names:?} 颜色：{:?}", size.options.iter().map(|o| o.color.as_str()).collect::<Vec<_>>());
        assert_eq!(opt_names, ["XS", "S", "M", "L", "XL"], "Size 选项应与线上一致");
        // 数字字段（Estimate）也要补成本地列，并把线上值写回条目
        let est = fields.iter().find(|f| f.name == "Estimate").expect("线上 Estimate 应补成本地列");
        assert_eq!(est.kind, "number");
        let vals: i64 = app
            .query_row(
                "SELECT count(*) FROM project_field_values WHERE field_id = ?1 AND value IS NOT NULL AND value <> ''",
                (&est.id,),
                |r| r.get(0),
            )
            .unwrap();
        eprintln!("Estimate 有值的条目：{vals}");
        assert!(vals > 0, "Estimate 的值应落库（卡片 chip 的数据面）");
        let status = fields.iter().find(|f| f.kind == "builtin_status").unwrap();
        let st: Vec<&str> = status.options.iter().map(|o| o.name.as_str()).collect();
        eprintln!("Status：{st:?}");
        assert_eq!(st, ["Backlog", "Ready", "In progress", "In review", "Done"]);
    }
}
