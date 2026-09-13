//! GitHub data source: shells out to the `gh` CLI. Keeping gh as a side
//! process means auth (the token stored in ~/.config/gh) and API channel
//! access come for free.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

use crate::models::{Comment, Issue, Pull};
use crate::source::{IssueStateFilter, Kind, MergeMethod, PullStateFilter, RepoRef, Source};

/// Fields requested from `gh issue list --json`.
const ISSUE_LIST_FIELDS: &str = "number,title,state,body,author,labels,\
milestone,assignees,createdAt,updatedAt,url";

/// Locate the gh executable.
///
/// A GUI-launched Tauri app does not inherit the user's login shell PATH
/// (especially on macOS, where .zprofile/Homebrew paths are missing), so
/// after PATH we probe the well-known install locations.
pub fn find_gh() -> Option<PathBuf> {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(executable_name("gh"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for dir in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
        "/usr/local/sbin",
    ] {
        let candidate = Path::new(dir).join(executable_name("gh"));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    // 三级：内嵌 sidecar（externalBin 打包后与主程序同目录——分发期兜底，
    // 用户零安装；dev 下 target/debug 旁通常没有 gh，自然跳过）。
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(executable_name("gh"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(windows)]
fn executable_name(name: &str) -> String {
    format!("{name}.exe")
}

#[cfg(not(windows))]
fn executable_name(name: &str) -> String {
    name.to_string()
}

/// Run a gh command with `repo` as the working directory.
///
/// gh resolves owner/repo from the directory's git remotes, so no remote
/// URL parsing is needed on our side.
/// args[0] 必须是 gh 子命令；-R owner/repo 由调用方按 RepoRef 注入
/// （本函数不再依赖工作目录——仅远端仓库同样可用）。
fn run_gh(args: &[&str]) -> Result<String> {
    let gh = find_gh().ok_or_else(|| {
        anyhow!("找不到 gh CLI，请先安装并执行 `gh auth login`（macOS: brew install gh）")
    })?;
    log::debug!("gh {:?}", args);

    let output = Command::new(gh)
        .args(args)
        .output()
        .with_context(|| format!("启动 gh 失败"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        log::debug!("gh 退出码 {:?}: {stderr}", output.status.code());
        return Err(anyhow!("gh 退出码 {:?}: {stderr}", output.status.code()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn gh_version() -> Option<String> {
    let gh = find_gh()?;
    let output = Command::new(gh).arg("--version").output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().next().map(|line| line.to_string())
}

/// GitHub 来源实现：gh CLI 子进程 + 免费认证。所有 gh 方言
/// （子命令 pr、旗标、状态大小写）都关在本 impl 与其辅助函数内。
pub struct GhSource;

impl Source for GhSource {
    fn fetch_issues(&self, repo: &RepoRef, state: IssueStateFilter, limit: u32) -> Result<Vec<Issue>> {
        fetch_issues(&format!("{}/{}", repo.owner, repo.repo), state.as_gh_str(), limit)
    }
    fn fetch_pulls(&self, repo: &RepoRef, state: PullStateFilter, limit: u32) -> Result<Vec<Pull>> {
        fetch_pulls(&format!("{}/{}", repo.owner, repo.repo), state.as_gh_str(), limit)
    }
    fn fetch_pull_detail(&self, repo: &RepoRef, number: &str) -> Result<Pull> {
        fetch_pull_detail(&format!("{}/{}", repo.owner, repo.repo), number)
    }
    fn fetch_comments(&self, repo: &RepoRef, kind: Kind, number: &str) -> Result<Vec<Comment>> {
        fetch_comments(&format!("{}/{}", repo.owner, repo.repo), kind, number)
    }
    fn add_comment(&self, repo: &RepoRef, kind: Kind, number: &str, body: &str) -> Result<Vec<Comment>> {
        add_comment(&format!("{}/{}", repo.owner, repo.repo), kind, number, body)
    }
    fn set_issue_state(&self, repo: &RepoRef, number: &str, closed: bool) -> Result<Issue> {
        set_issue_state(&format!("{}/{}", repo.owner, repo.repo), number, closed)
    }
    fn set_pull_state(&self, repo: &RepoRef, number: &str, closed: bool) -> Result<Pull> {
        set_pull_state(&format!("{}/{}", repo.owner, repo.repo), number, closed)
    }
    fn merge_pull(&self, repo: &RepoRef, number: &str, method: MergeMethod) -> Result<Pull> {
        merge_pull(&format!("{}/{}", repo.owner, repo.repo), number, method)
    }
    fn repo_visibility(&self, repo: &RepoRef) -> Result<&'static str> {
        repo_visibility(&format!("{}/{}", repo.owner, repo.repo))
    }
}

/// 过滤器的 gh 方言（恰好与前端口径一致）。
trait AsGhStr {
    fn as_gh_str(self) -> &'static str;
}
impl AsGhStr for IssueStateFilter {
    fn as_gh_str(self) -> &'static str {
        match self {
            IssueStateFilter::Open => "open",
            IssueStateFilter::Closed => "closed",
            IssueStateFilter::All => "all",
        }
    }
}
impl AsGhStr for PullStateFilter {
    fn as_gh_str(self) -> &'static str {
        match self {
            PullStateFilter::Open => "open",
            PullStateFilter::Closed => "closed",
            PullStateFilter::Merged => "merged",
            PullStateFilter::All => "all",
        }
    }
}

/// Fetch issues via `gh issue list`. `state` is "open" | "closed" | "all".
fn fetch_issues(slug: &str, state: &str, limit: u32) -> Result<Vec<Issue>> {
    let limit = limit.clamp(1, 1000).to_string();
    let args = [
        "issue", "list", "--repo", slug, "--json", ISSUE_LIST_FIELDS, "--state", state,
        "--limit", &limit,
    ];
    let stdout = run_gh(&args)?;
    parse_issues(&stdout)
}

fn parse_issues(stdout: &str) -> Result<Vec<Issue>> {
    let values: Vec<Value> =
        serde_json::from_str(stdout).context("解析 gh 的 JSON 输出失败")?;
    Ok(values.iter().map(parse_issue_value).collect())
}

fn parse_issue_value(v: &Value) -> Issue {
    let labels = v
        .get("labels")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|l| l.get("name").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let assignees = v
        .get("assignees")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|u| u.get("login").and_then(Value::as_str).map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Issue {
        number: crate::source::json_number_to_string(v.get("number")),
        title: v
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        state: v
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("OPEN")
            .to_string(),
        body: string_field(v, "body"),
        author: v.get("author").and_then(|a| a.get("login")).and_then(Value::as_str).map(str::to_string),
        milestone: v
            .get("milestone")
            .and_then(|m| m.get("title"))
            .and_then(Value::as_str)
            .map(str::to_string),
        labels,
        assignees,
        created_at: string_field(v, "createdAt"),
        updated_at: string_field(v, "updatedAt"),
        url: string_field(v, "url"),
    }
}

/// Minimal fields for `gh pr list --json`. Nested connections (reviews,
/// reviewRequests, commits, comments, labels, assignees, body) must stay out:
/// across up to 100 PRs they exceed GitHub's ~500k GraphQL node budget
/// ("This query requests up to 530,050 points"). Heavy fields are fetched per
/// PR via `gh pr view` in [`fetch_pull_detail`], following the same
/// light-list / heavy-detail split.
const PR_LIST_FIELDS: &str = "number,title,state,author,headRefName,baseRefName,\
createdAt,updatedAt,url,additions,deletions,isDraft,reviewDecision";

/// Fields added on top of the list set for `gh pr view <n> --json`.
const PR_DETAIL_FIELDS: &str = "body,labels,assignees,reviewRequests,reviews,\
commits,comments";

/// Fetch pull requests via `gh pr list`. `state` is
/// "open" | "closed" | "merged" | "all".
///
/// Note: `gh pr list --state closed` returns both merged and unmerged-closed
/// PRs (gh folds MERGED into the "closed" query), so the closed case over-
/// fetches and drops MERGED rows afterwards. The multiplier covers skewed
/// histories like tauri's, where the most recent closed window is ~80% merges.
fn fetch_pulls(slug: &str, state: &str, limit: u32) -> Result<Vec<Pull>> {
    let limit = limit.clamp(1, 1000);
    let unmerged_only = state == "closed";
    // Cheap scalar-only rows; asking for a wider window costs little.
    let fetch_limit = if unmerged_only {
        (limit.saturating_mul(6)).clamp(1, 1000)
    } else {
        limit
    };
    let fetch_limit = fetch_limit.to_string();
    let args = [
        "pr", "list", "--repo", slug, "--json", PR_LIST_FIELDS, "--state", state,
        "--limit", &fetch_limit,
    ];
    let stdout = run_gh(&args)?;
    let mut pulls = parse_pulls(&stdout)?;
    if unmerged_only {
        pulls = without_merged(pulls);
        pulls.truncate(limit as usize);
    }
    Ok(pulls)
}

/// Keep only unmerged-closed PRs (state CLOSED, not MERGED).
fn without_merged(pulls: Vec<Pull>) -> Vec<Pull> {
    pulls.into_iter().filter(|p| p.state != "MERGED").collect()
}

/// Fetch one PR with full fields via `gh pr view <number> --json`.
fn fetch_pull_detail(slug: &str, number: &str) -> Result<Pull> {
    let fields = format!("{PR_LIST_FIELDS},{PR_DETAIL_FIELDS}");
    let args = ["pr", "view", number, "--repo", slug, "--json", &fields];
    let stdout = run_gh(&args)?;
    let value: Value =
        serde_json::from_str(&stdout).context("解析 gh pr view 的 JSON 输出失败")?;
    Ok(parse_pull_value(&value))
}

/// Repo visibility via `gh repo view --json visibility`. PUBLIC /
/// PRIVATE / INTERNAL（GHE 企业可见，亦非公开）→ public/private。
/// 注意：`repo view` 不接受 `-R`（本机 gh 2.92 实测 unknown shorthand
/// flag），仓库用位置参数传；显式 <repository> 不依赖工作目录。
fn repo_visibility(slug: &str) -> Result<&'static str> {
    let stdout = run_gh(&["repo", "view", slug, "--json", "visibility", "-q", ".visibility"])?;
    Ok(match stdout.trim().to_ascii_uppercase().as_str() {
        "PUBLIC" => "public",
        "" => return Err(anyhow!("gh 未返回 visibility（仓库不存在或无权限）")),
        _ => "private",
    })
}

// ---- Mutations & conversations (the P1 write-through surface) ----

/// Map the entity kind (what the storage layer and frontend call it:
/// "issue" | "pull") to gh's subcommand — which is `pr`, NOT `pull`.
/// Passing the kind through verbatim sent `gh pull view` to gh and failed
/// with `unknown command "pull"`.
fn gh_subcommand(kind: Kind) -> &'static str {
    match kind {
        Kind::Issue => "issue",
        Kind::Pull => "pr",
    }
}

/// Fetch an entity's conversation comments via `gh issue|pr view --json
/// comments`. `kind` is the entity kind "issue" | "pull".
fn fetch_comments(slug: &str, kind: Kind, number: &str) -> Result<Vec<Comment>> {
    let sub = gh_subcommand(kind);
    let args = [sub, "view", number, "--repo", slug, "--json", "comments"];
    let stdout = run_gh(&args)?;
    let value: Value = serde_json::from_str(&stdout).context("解析 gh 的评论 JSON 失败")?;
    Ok(value
        .get("comments")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(parse_comment_value).collect())
        .unwrap_or_default())
}

fn parse_comment_value(v: &Value) -> Comment {
    Comment {
        author: v
            .get("author")
            .and_then(|a| a.get("login"))
            .and_then(Value::as_str)
            .map(str::to_string),
        body: string_field(v, "body"),
        created_at: string_field(v, "createdAt"),
        pending: false,
    }
}

/// Post a comment via `gh issue|pr comment`, then re-read the conversation.
/// Returning the fresh list IS the write-through: one roundtrip leaves the
/// cache and the UI consistent without a separate refresh call.
fn add_comment(slug: &str, kind: Kind, number: &str, body: &str) -> Result<Vec<Comment>> {
    let sub = gh_subcommand(kind);
    let args = [sub, "comment", number, "--repo", slug, "--body", body];
    run_gh(&args)?;
    fetch_comments(slug, kind, number)
}

/// Whitelist + translate the merge method into gh's flag. gh prompts
/// interactively without one of these, which would hang the shell call.
/// Translate the merge method into gh's flag. gh prompts interactively
/// without one of these, which would hang the shell call. 注入防护由
/// source::MergeMethod::parse 的枚举白名单承担。
fn merge_flag(method: MergeMethod) -> &'static str {
    match method {
        MergeMethod::Merge => "--merge",
        MergeMethod::Squash => "--squash",
        MergeMethod::Rebase => "--rebase",
    }
}

/// Merge a pull request, then re-read the full record (write-through: the
/// fresh MERGED state becomes the single source for store patching).
fn merge_pull(slug: &str, number: &str, method: MergeMethod) -> Result<Pull> {
    let flag = merge_flag(method);
    let args = ["pr", "merge", number, "--repo", slug, flag];
    run_gh(&args)?;
    fetch_pull_detail(slug, number)
}

/// 线上仓库清单（gh 托管账户，`gh repo list`）——「刷新从线上查找」的
/// GitHub 实现。url 即 https 仓库地址，可直接用于仅远端登记。
pub fn list_user_repos(limit: u32) -> Result<Vec<crate::source::RemoteRepoInfo>> {
    let limit = limit.clamp(1, 200).to_string();
    let args = [
        "repo",
        "list",
        "--limit",
        &limit,
        "--json",
        "nameWithOwner,description,updatedAt,url",
    ];
    let stdout = run_gh(&args)?;
    let values: Vec<Value> =
        serde_json::from_str(&stdout).context("解析 gh repo list 的 JSON 输出失败")?;
    Ok(values
        .iter()
        .map(|v| crate::source::RemoteRepoInfo {
            full_name: v
                .get("nameWithOwner")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            url: v.get("url").and_then(Value::as_str).unwrap_or_default().to_string(),
            description: v.get("description").and_then(Value::as_str).map(str::to_string),
            updated_at: v.get("updatedAt").and_then(Value::as_str).map(str::to_string),
        })
        .collect())
}

/// Cheap connectivity probe: `gh api user` is one free authenticated call
/// (does not count against the rate limit... actually it does count; but a
/// probe is user-initiated and rare). Ok => reachable; Err carries the raw
/// gh output for the frontend to classify (auth failure still means online).
pub fn probe_network() -> Result<()> {
    let output = Command::new(find_gh().ok_or_else(|| anyhow!("找不到 gh CLI"))?)
        .args(["api", "user", "--jq", ".login"])
        .output()
        .context("启动 gh 失败")?;
    if output.status.success() {
        return Ok(());
    }
    Err(anyhow!("{}", String::from_utf8_lossy(&output.stderr).trim()))
}

/// Close or reopen an issue; returns the fresh entity for store patching.
fn set_issue_state(slug: &str, number: &str, closed: bool) -> Result<Issue> {
    let verb = if closed { "close" } else { "reopen" };
    let args = ["issue", verb, number, "--repo", slug];
    run_gh(&args)?;
    let args = ["issue", "view", number, "--repo", slug, "--json", ISSUE_LIST_FIELDS];
    let stdout = run_gh(&args)?;
    let value: Value =
        serde_json::from_str(&stdout).context("解析 gh issue view 的 JSON 输出失败")?;
    Ok(parse_issue_value(&value))
}

/// Close or reopen a pull request; returns the fresh full record so a close
/// that raced a merge surfaces as MERGED, not CLOSED.
fn set_pull_state(slug: &str, number: &str, closed: bool) -> Result<Pull> {
    let verb = if closed { "close" } else { "reopen" };
    let args = ["pr", verb, number, "--repo", slug];
    run_gh(&args)?;
    fetch_pull_detail(slug, number)
}

fn parse_pulls(stdout: &str) -> Result<Vec<Pull>> {
    let values: Vec<Value> =
        serde_json::from_str(stdout).context("解析 gh 的 JSON 输出失败")?;
    Ok(values.iter().map(parse_pull_value).collect())
}

fn parse_pull_value(v: &Value) -> Pull {
    let labels = name_list(v, "labels");
    let assignees = login_list(v, "assignees");

    // Reviewers: people with an outstanding review request plus everyone
    // who already submitted a review, de-duplicated.
    let mut reviewers = login_list(v, "reviewRequests");
    for login in login_list(v, "reviews") {
        if !reviewers.contains(&login) {
            reviewers.push(login);
        }
    }

    let commits = v
        .get("commits")
        .and_then(Value::as_array)
        .map(|a| a.len() as i64)
        .unwrap_or_default();
    let comments = v
        .get("comments")
        .and_then(Value::as_array)
        .map(|a| a.len() as i64)
        .unwrap_or_default();

    Pull {
        number: v.get("number").and_then(Value::as_i64).unwrap_or_default(),
        title: v
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        state: v
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("OPEN")
            .to_string(),
        body: string_field(v, "body"),
        author: v
            .get("author")
            .and_then(|a| a.get("login"))
            .and_then(Value::as_str)
            .map(str::to_string),
        head_ref: string_field(v, "headRefName"),
        base_ref: string_field(v, "baseRefName"),
        labels,
        assignees,
        reviewers,
        review_decision: string_field(v, "reviewDecision"),
        additions: v.get("additions").and_then(Value::as_i64).unwrap_or_default(),
        deletions: v.get("deletions").and_then(Value::as_i64).unwrap_or_default(),
        commits,
        comments,
        is_draft: v.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        created_at: string_field(v, "createdAt"),
        updated_at: string_field(v, "updatedAt"),
        url: string_field(v, "url"),
    }
}

/// Collect `{ "name": … }` strings from an array field (labels).
fn name_list(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("name").and_then(Value::as_str).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Collect `{ "author": {"login": …} }` / `{ "login": … }` logins from an
/// array field (assignees, reviewRequests, reviews).
fn login_list(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let login = item
                        .get("author")
                        .and_then(|a| a.get("login"))
                        .or_else(|| item.get("login"))
                        .and_then(Value::as_str)?;
                    (!login.is_empty()).then_some(login.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn string_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Output of `git remote get-url origin` in `repo`, if any.
pub fn git_origin(repo: &Path) -> Option<String> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(repo)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!url.is_empty()).then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"[
      {
        "number": 42,
        "title": "Kanban drag fails across columns",
        "state": "OPEN",
        "body": "steps to reproduce",
        "author": {"login": "zicowarn"},
        "labels": [{"name": "bug"}, {"name": "ui"}],
        "milestone": {"title": "v1.0"},
        "assignees": [{"login": "zicowarn"}],
        "createdAt": "2026-06-01T10:00:00Z",
        "updatedAt": "2026-06-29T12:30:00Z",
        "url": "https://github.com/zicowarn/HiveTask/issues/42"
      },
      {
        "number": 41,
        "title": "Closed issue with missing optionals",
        "state": "CLOSED",
        "body": null,
        "author": null,
        "labels": [],
        "milestone": null,
        "assignees": [],
        "createdAt": null,
        "updatedAt": null,
        "url": "https://github.com/zicowarn/HiveTask/issues/41"
      }
    ]"#;

    #[test]
    fn parses_gh_issue_list_json() {
        let issues = parse_issues(SAMPLE).expect("parse");
        assert_eq!(issues.len(), 2);

        let first = &issues[0];
        assert_eq!(first.number, "42");
        assert_eq!(first.state, "OPEN");
        assert_eq!(first.author.as_deref(), Some("zicowarn"));
        assert_eq!(first.labels, vec!["bug", "ui"]);
        assert_eq!(first.milestone.as_deref(), Some("v1.0"));
        assert_eq!(first.assignees, vec!["zicowarn"]);

        let second = &issues[1];
        assert_eq!(second.number, "41");
        assert!(second.body.is_none());
        assert!(second.author.is_none());
        assert!(second.labels.is_empty());
    }

    #[test]
    fn parses_empty_array() {
        assert!(parse_issues("[]").unwrap().is_empty());
    }

    const PR_SAMPLE: &str = r#"[
      {
        "number": 17,
        "title": "Add Tauri backend",
        "state": "MERGED",
        "body": "rewrite",
        "author": {"login": "zicowarn"},
        "labels": [{"name": "refactor"}],
        "assignees": [{"login": "zicowarn"}],
        "reviewRequests": [{"login": "reviewer2"}],
        "reviews": [
          {"author": {"login": "reviewer1"}, "state": "APPROVED"},
          {"author": {"login": "reviewer2"}, "state": "COMMENTED"}
        ],
        "reviewDecision": "APPROVED",
        "additions": 512,
        "deletions": 128,
        "commits": [{"oid": "a"}, {"oid": "b"}],
        "comments": [{"id": 1}],
        "isDraft": false,
        "headRefName": "feat/tauri",
        "baseRefName": "main",
        "createdAt": "2026-09-01T10:00:00Z",
        "updatedAt": "2026-09-05T12:00:00Z",
        "url": "https://github.com/zicowarn/HiveTask/pull/17"
      }
    ]"#;

    #[test]
    fn parses_gh_pr_list_json() {
        let pulls = parse_pulls(PR_SAMPLE).expect("parse");
        assert_eq!(pulls.len(), 1);
        let p = &pulls[0];
        assert_eq!(p.number, 17);
        assert_eq!(p.state, "MERGED");
        assert_eq!(p.author.as_deref(), Some("zicowarn"));
        assert_eq!(p.labels, vec!["refactor"]);
        assert_eq!(p.head_ref.as_deref(), Some("feat/tauri"));
        assert_eq!(p.base_ref.as_deref(), Some("main"));
        // reviewer2 appears both in reviewRequests and reviews: de-duplicated
        assert_eq!(p.reviewers, vec!["reviewer2", "reviewer1"]);
        assert_eq!(p.review_decision.as_deref(), Some("APPROVED"));
        assert_eq!(p.additions, 512);
        assert_eq!(p.deletions, 128);
        assert_eq!(p.commits, 2);
        assert_eq!(p.comments, 1);
        assert!(!p.is_draft);
    }

    #[test]
    fn parses_empty_pr_array() {
        assert!(parse_pulls("[]").unwrap().is_empty());
    }

    const COMMENTS_SAMPLE: &str = r#"{
      "comments": [
        {
          "author": {"login": "alice", "isBot": false},
          "body": "Reproduced on Fedora 44.",
          "createdAt": "2026-09-01T12:00:00Z"
        },
        {
          "author": {"login": "bob"},
          "body": null,
          "createdAt": null
        }
      ]
    }"#;

    #[test]
    fn parses_gh_comments_json() {
        let value: Value = serde_json::from_str(COMMENTS_SAMPLE).unwrap();
        let comments: Vec<Comment> = value
            .get("comments")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(parse_comment_value).collect())
            .unwrap_or_default();
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].author.as_deref(), Some("alice"));
        assert_eq!(comments[0].body.as_deref(), Some("Reproduced on Fedora 44."));
        assert_eq!(comments[0].created_at.as_deref(), Some("2026-09-01T12:00:00Z"));
        assert!(!comments[0].pending);
        assert!(comments[1].body.is_none());
        assert!(comments[1].created_at.is_none());
    }

    #[test]
    fn gh_subcommand_translates_kind() {
        assert_eq!(gh_subcommand(Kind::Pull), "pr");
        assert_eq!(gh_subcommand(Kind::Issue), "issue");
    }

    #[test]
    fn entity_kind_maps_to_gh_subcommand() {
        // The storage/frontend kind "pull" must translate to gh's `pr`;
        // passing it through verbatim produced `unknown command "pull"`.
        assert_eq!(gh_subcommand(Kind::Pull), "pr");
        assert_eq!(gh_subcommand(Kind::Issue), "issue");
    }

    #[test]
    fn parses_missing_comments_field() {
        let value: Value = serde_json::from_str("{}").unwrap();
        let comments: Vec<Comment> = value
            .get("comments")
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(parse_comment_value).collect())
            .unwrap_or_default();
        assert!(comments.is_empty());
    }

    #[test]
    fn closed_tab_drops_merged_rows() {
        // gh folds merged PRs into `--state closed`; the Closed tab must not
        // surface them because Merged has its own tab.
        let mixed = r#"[
          {"number": 3, "title": "merged but returned with --state closed", "state": "MERGED"},
          {"number": 2, "title": "actually closed unmerged", "state": "CLOSED"},
          {"number": 1, "title": "also merged", "state": "MERGED"}
        ]"#;
        let pulls = without_merged(parse_pulls(mixed).expect("parse"));
        assert_eq!(pulls.len(), 1);
        assert_eq!(pulls[0].number, 2);
        assert_eq!(pulls[0].state, "CLOSED");
    }

    #[test]
    fn pr_list_rows_default_missing_detail_fields() {
        // The list query omits body/labels/reviews/commits connections to
        // stay within GitHub's node budget: they must degrade to empties.
        let minimal = r#"[
          {
            "number": 3,
            "title": "Small PR",
            "state": "OPEN",
            "author": {"login": "a"},
            "additions": 1,
            "deletions": 0,
            "headRefName": "x",
            "baseRefName": "main",
            "isDraft": true,
            "reviewDecision": null,
            "createdAt": null,
            "updatedAt": null,
            "url": "https://github.com/o/r/pull/3"
          }
        ]"#;
        let pulls = parse_pulls(minimal).unwrap();
        assert_eq!(pulls.len(), 1);
        let p = &pulls[0];
        assert!(p.is_draft);
        assert!(p.body.is_none());
        assert!(p.labels.is_empty());
        assert!(p.reviewers.is_empty());
        assert_eq!(p.commits, 0);
        assert_eq!(p.comments, 0);
        assert!(p.review_decision.is_none());
    }
}
