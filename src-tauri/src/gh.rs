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

/// 与 run_gh 同，但把 body 写进子进程 stdin（`gh api graphql --input -`）。
/// GraphQL 的 variables 是嵌套对象，只能整包 JSON 传——`-f variables=…` 传的是字符串，
/// 服务端会以 `Variable $input … was provided invalid value` 拒绝。
fn run_gh_stdin(args: &[&str], body: &str) -> Result<String> {
    use std::io::Write;
    let gh = find_gh().ok_or_else(|| {
        anyhow!("找不到 gh CLI，请先安装并执行 `gh auth login`（macOS: brew install gh）")
    })?;
    let mut child = Command::new(gh)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .with_context(|| "启动 gh 失败".to_string())?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| anyhow!("无法写入 gh stdin"))?
        .write_all(body.as_bytes())
        .context("写入 gh stdin 失败")?;
    let output = child.wait_with_output().context("等待 gh 结束失败")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
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
    fn set_issue_state(&self, repo: &RepoRef, number: &str, closed: bool, reason: Option<&str>) -> Result<Issue> {
        set_issue_state(&format!("{}/{}", repo.owner, repo.repo), number, closed, reason)
    }
    fn set_issue_locked(&self, repo: &RepoRef, number: &str, locked: bool) -> Result<()> {
        set_issue_locked(&format!("{}/{}", repo.owner, repo.repo), number, locked)
    }
    fn delete_issue(&self, repo: &RepoRef, number: &str) -> Result<()> {
        delete_issue(&format!("{}/{}", repo.owner, repo.repo), number)
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
    fn create_issue(&self, repo: &RepoRef, title: &str, body: Option<&str>, milestone: Option<&str>, labels: &[String], assignees: &[String]) -> Result<Issue> {
        create_issue(&format!("{}/{}", repo.owner, repo.repo), title, body, milestone, labels, assignees)
    }
    fn list_labels(&self, repo: &RepoRef) -> Result<Vec<crate::models::LabelInfo>> {
        list_labels(&format!("{}/{}", repo.owner, repo.repo))
    }
    fn list_assignees(&self, repo: &RepoRef) -> Result<Vec<String>> {
        list_assignees(&format!("{}/{}", repo.owner, repo.repo))
    }
    fn create_label(&self, repo: &RepoRef, name: &str, color: &str) -> Result<crate::models::LabelInfo> {
        create_label(&format!("{}/{}", repo.owner, repo.repo), name, color)
    }
    fn update_issue(&self, repo: &RepoRef, number: &str, title: &str, body: Option<&str>) -> Result<Issue> {
        update_issue(&format!("{}/{}", repo.owner, repo.repo), number, title, body)
    }
    fn update_issue_milestone(&self, repo: &RepoRef, number: &str, milestone: Option<&str>) -> Result<Issue> {
        update_issue_milestone(&format!("{}/{}", repo.owner, repo.repo), number, milestone)
    }
    fn update_issue_labels(&self, repo: &RepoRef, number: &str, labels: &[String]) -> Result<Issue> {
        update_issue_labels(&format!("{}/{}", repo.owner, repo.repo), number, labels)
    }
    fn update_issue_assignees(&self, repo: &RepoRef, number: &str, assignees: &[String]) -> Result<Issue> {
        update_issue_assignees(&format!("{}/{}", repo.owner, repo.repo), number, assignees)
    }
    fn create_milestone(&self, repo: &RepoRef, title: &str, due_on: Option<&str>, description: Option<&str>) -> Result<String> {
        create_milestone(&format!("{}/{}", repo.owner, repo.repo), title, due_on, description)
    }
    fn create_pull(&self, repo: &RepoRef, head: &str, base: &str, title: &str, body: Option<&str>) -> Result<Pull> {
        create_pull(&format!("{}/{}", repo.owner, repo.repo), head, base, title, body)
    }
    fn remote_branches(&self, repo: &RepoRef) -> Result<Vec<String>> {
        remote_branches(&format!("{}/{}", repo.owner, repo.repo))
    }
    fn list_milestones(&self, repo: &RepoRef) -> Result<Vec<crate::models::MilestoneInfo>> {
        list_milestones(&format!("{}/{}", repo.owner, repo.repo))
    }
    fn set_milestone_state(&self, repo: &RepoRef, number: i64, closed: bool) -> Result<crate::models::MilestoneInfo> {
        set_milestone_state(&format!("{}/{}", repo.owner, repo.repo), number, closed)
    }
    fn update_milestone(&self, repo: &RepoRef, number: i64, title: &str, description: Option<&str>, due_on: Option<&str>) -> Result<crate::models::MilestoneInfo> {
        update_milestone(&format!("{}/{}", repo.owner, repo.repo), number, title, description, due_on)
    }
    fn fetch_issue_relations(&self, repo: &RepoRef, number: &str) -> Result<crate::models::IssueRelations> {
        fetch_issue_relations(&format!("{}/{}", repo.owner, repo.repo), number)
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

/// Issue 关系（依赖 blockedBy/blocking + 父子 subIssues/subIssuesSummary）
/// ——**详情级按需拉取**：嵌套连接进列表必炸 node budget（PR_LIST_FIELDS
/// 的教训）；且关系数据只被详情面板与甘特用，列表不需要。
///
/// 一次 GraphQL 取全四类；子 Issue 只取前 50（平台 UI 同样折叠展示）。
pub fn fetch_issue_relations(slug: &str, number: &str) -> Result<crate::models::IssueRelations> {
    let (owner, repo) = slug
        .split_once('/')
        .ok_or_else(|| anyhow!("仓库 slug 形态异常: {slug}"))?;
    let n: u64 = number
        .parse()
        .map_err(|_| anyhow!("Issue 编号非数字（该来源可能不支持关系数据）: {number}"))?;
    let query = format!(
        "query{{ repository(owner:\"{owner}\",name:\"{repo}\"){{ issue(number:{n}){{ \
         blockedBy(first:50){{ nodes{{ number title state }} }} \
         blocking(first:50){{ nodes{{ number title state }} }} \
         parent{{ number title state }} \
         subIssues(first:50){{ nodes{{ number title state }} }} \
         subIssuesSummary{{ total completed }} \
         }} }} }}"
    );
    let stdout = run_gh(&["api", "graphql", "-f", &format!("query={query}")])?;
    let v: Value = serde_json::from_str(&stdout).context("解析 gh api graphql（关系）输出失败")?;
    let issue = &v["data"]["repository"]["issue"];
    if issue.is_null() {
        return Err(anyhow!("仓库或 Issue 不可见（关系数据拉取失败）"));
    }
    Ok(parse_relations_value(issue))
}

fn parse_relations_value(issue: &Value) -> crate::models::IssueRelations {
    use crate::models::{IssueRef, IssueRelations, SubIssueSummary};
    let refs = |conn: &Value| -> Vec<IssueRef> {
        conn["nodes"]
            .as_array()
            .map(|arr| arr.iter().filter_map(parse_issue_ref).collect())
            .unwrap_or_default()
    };
    let parent = parse_issue_ref(&issue["parent"]);
    let summary = &issue["subIssuesSummary"];
    let sub_summary = match (summary["total"].as_i64(), summary["completed"].as_i64()) {
        (Some(total), Some(completed)) if total > 0 => Some(SubIssueSummary { total, completed }),
        _ => None,
    };
    IssueRelations {
        blocked_by: refs(&issue["blockedBy"]),
        blocking: refs(&issue["blocking"]),
        parent,
        sub_issues: refs(&issue["subIssues"]),
        sub_summary,
    }
}

fn parse_issue_ref(v: &Value) -> Option<crate::models::IssueRef> {
    let number = v["number"].as_u64()?;
    Some(crate::models::IssueRef {
        number: number.to_string(),
        title: v["title"].as_str().unwrap_or_default().to_string(),
        state: v["state"].as_str().unwrap_or("OPEN").to_string(),
    })
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
/// 线上 ProjectsV2 清单（GitHub Projects）：viewer 名下按最近更新排序。
/// 需要 token 具备 `read:project` scope——缺失时把官方提示透传为可读错误。
pub fn list_user_projects(limit: u32) -> Result<Vec<RemoteProject>> {
    let limit = limit.clamp(1, 100).to_string();
    let query = format!(
        "query{{viewer{{projectsV2(first:{limit},orderBy:{{field:UPDATED_AT,direction:DESC}}){{totalCount nodes{{number title url closed}}}}}}}}"
    );
    let stdout = run_gh(&["api", "graphql", "-f", &format!("query={query}")])?;
    let v: Value = serde_json::from_str(&stdout).context("解析 gh api graphql 的 JSON 输出失败")?;
    if let Some(errs) = v.get("errors") {
        let msg = errs
            .as_array()
            .and_then(|a| a.first())
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("未知 GraphQL 错误");
        if msg.contains("read:project") {
            anyhow::bail!("当前 gh 凭据缺少 read:project 授权：请在 GitHub → Settings → Developer settings → Personal access tokens 为 gh 的令牌勾选 read:project 后重试");
        }
        anyhow::bail!("拉取线上项目失败：{msg}");
    }
    let nodes = v
        .pointer("/data/viewer/projectsV2/nodes")
        .and_then(Value::as_array)
        .context("GraphQL 返回缺少 projectsV2.nodes")?;
    Ok(nodes
        .iter()
        .filter_map(|n| {
            Some(RemoteProject {
                number: n.get("number")?.as_i64()? as u32,
                title: n.get("title")?.as_str()?.to_string(),
                url: n.get("url")?.as_str()?.to_string(),
                closed: n.get("closed")?.as_bool()?,
            })
        })
        .collect())
}

/// 线上 ProjectsV2 项目条目（清单用；绑定/导入在后续迭代）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProject {
    pub number: u32,
    pub title: String,
    pub url: String,
    pub closed: bool,
}

/// 线上 ProjectsV2 的条目（Issue/PR 引用 + 单选字段值名）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProjectItem {
    /// "zicowarn/PDFReferencev17CN"；草稿条目为 None。
    pub repo_full_name: Option<String>,
    pub number: Option<u32>,
    pub title: Option<String>,
    pub state: Option<String>,
    /// 字段名 → 值（单选给选项名如 "Done"/"P0"；数字/文本/日期给其文本形式）。
    pub values: std::collections::BTreeMap<String, String>,
}

/// 线上 ProjectsV2 的单选字段定义（列设置的真源：名称 + 选项 + 颜色/说明）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProjectField {
    /// 线上字段 id（发布本地列时需要）。
    pub id: Option<String>,
    pub name: String,
    /// 线上字段类型（SINGLE_SELECT / NUMBER / TEXT / DATE …）；单选字段为 None（由 options 判定）。
    pub data_type: Option<String>,
    pub options: Vec<RemoteFieldOption>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFieldOption {
    pub name: String,
    /// 平台色名（GRAY/BLUE/GREEN/YELLOW/ORANGE/RED/PINK/PURPLE）。
    pub color: String,
    pub description: Option<String>,
}

/// 项目快照：条目 + 字段定义（列设置）一次拉齐。
pub struct ProjectSnapshot {
    pub items: Vec<RemoteProjectItem>,
    pub fields: Vec<RemoteProjectField>,
}

/// 拉取线上 ProjectsV2 的条目（owner_kind = "user" | "org"）。
pub fn fetch_project_items(
    owner_kind: &str,
    owner: &str,
    number: u32,
    limit: u32,
) -> Result<ProjectSnapshot> {
    let limit = limit.clamp(1, 200);
    let owner_field = if owner_kind == "org" { "organization" } else { "user" };
    let query = format!(
        "query{{ {owner_field}(login:\"{owner}\"){{ projectV2(number:{number}){{ items(first:{limit}){{ nodes{{ \
         content{{ ... on Issue {{ number title state repository{{ nameWithOwner }} }} \
                   ... on PullRequest {{ number title state repository{{ nameWithOwner }} }} \
                   ... on DraftIssue {{ title }} }} \
         fieldValues(first:30){{ nodes{{ \
           ... on ProjectV2ItemFieldSingleSelectValue {{ name field{{ ... on ProjectV2SingleSelectField {{ name }} }} }} \
           ... on ProjectV2ItemFieldNumberValue {{ number field{{ ... on ProjectV2FieldCommon {{ name }} }} }} \
           ... on ProjectV2ItemFieldTextValue {{ text field{{ ... on ProjectV2FieldCommon {{ name }} }} }} \
           ... on ProjectV2ItemFieldDateValue {{ date field{{ ... on ProjectV2FieldCommon {{ name }} }} }} \
         }} }} }} }} \
         fields(first:30){{ nodes{{ \
           ... on ProjectV2SingleSelectField {{ id name options{{ name color description }} }} \
           ... on ProjectV2FieldCommon {{ id name dataType }} \
         }} }} }} }} }}"
    );
    let stdout = run_gh(&["api", "graphql", "-f", &format!("query={query}")])?;
    let v: Value = serde_json::from_str(&stdout).context("解析 gh api graphql 的 JSON 输出失败")?;
    if let Some(errs) = v.get("errors") {
        let msg = errs
            .as_array()
            .and_then(|a| a.first())
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("未知 GraphQL 错误");
        if msg.contains("read:project") {
            anyhow::bail!("当前 gh 凭据缺少 read:project 授权：在 GitHub 为 gh 令牌勾选该权限后重试");
        }
        anyhow::bail!("拉取项目条目失败：{msg}");
    }
    let fields = v
        .pointer(&format!("/data/{owner_field}/projectV2/fields/nodes"))
        .and_then(Value::as_array)
        .map(|ns| {
            ns.iter()
                .filter_map(|f| {
                    let name = f.get("name")?.as_str()?.to_string();
                    // 单选字段有 options；数字/文本/日期字段没有（空表）
                    let options = f
                        .get("options")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or(&[])
                        .iter()
                        .filter_map(|o| {
                            Some(RemoteFieldOption {
                                name: o.get("name")?.as_str()?.to_string(),
                                color: o.get("color").and_then(Value::as_str).unwrap_or("GRAY").to_string(),
                                description: o
                                    .get("description")
                                    .and_then(Value::as_str)
                                    .filter(|d| !d.trim().is_empty())
                                    .map(str::to_string),
                            })
                        })
                        .collect::<Vec<_>>();
                    Some(RemoteProjectField {
                        id: f.get("id").and_then(Value::as_str).map(str::to_string),
                        name,
                        data_type: f.get("dataType").and_then(Value::as_str).map(str::to_string),
                        options,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let nodes = v
        .pointer(&format!("/data/{owner_field}/projectV2/items/nodes"))
        .and_then(Value::as_array)
        .context("GraphQL 返回缺少 items.nodes")?;
    Ok(snapshot(nodes, fields))
}

/// 组装快照（条目 + 字段）。
fn snapshot(nodes: &[Value], fields: Vec<RemoteProjectField>) -> ProjectSnapshot {
    let items = nodes
        .iter()
        .map(|n| {
            let content = n.get("content").unwrap_or(&Value::Null);
            let mut values = std::collections::BTreeMap::new();
            if let Some(fv) = content
                .get("fieldValues")
                .or_else(|| n.get("fieldValues"))
                .and_then(|f| f.get("nodes"))
                .and_then(Value::as_array)
            {
                for item in fv {
                    let field = match item.pointer("/field/name").and_then(Value::as_str) {
                        Some(f) => f,
                        None => continue,
                    };
                    // 单选给选项名；数字给数值（2.0 → "2"）；文本/日期给原文
                    let value = item
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .or_else(|| {
                            item.get("number").and_then(Value::as_f64).map(|n| {
                                if n.fract() == 0.0 {
                                    format!("{}", n as i64)
                                } else {
                                    format!("{n}")
                                }
                            })
                        })
                        .or_else(|| item.get("text").and_then(Value::as_str).map(str::to_string))
                        .or_else(|| item.get("date").and_then(Value::as_str).map(str::to_string));
                    if let Some(val) = value {
                        values.insert(field.to_string(), val);
                    }
                }
            }
            RemoteProjectItem {
                repo_full_name: content
                    .pointer("/repository/nameWithOwner")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                number: content.get("number").and_then(Value::as_i64).map(|n| n as u32),
                title: content.get("title").and_then(Value::as_str).map(str::to_string),
                state: content.get("state").and_then(Value::as_str).map(str::to_string),
                values,
            }
        })
        .collect();
    ProjectSnapshot { items, fields }
}

/// 把一组单选选项发布到线上项目字段（整表替换：updateProjectV2Field）。
/// 需要 `project` 写权限（read:project 不够）——不足时给可读指引。
pub fn publish_field_options(
    owner_kind: &str,
    owner: &str,
    number: u32,
    field_name: &str,
    options: &[(String, String, Option<String>)],
) -> Result<()> {
    let owner_field = if owner_kind == "org" { "organization" } else { "user" };
    // ① 找线上字段 id
    let q = format!(
        "query{{ {owner_field}(login:\"{owner}\"){{ projectV2(number:{number}){{ fields(first:20){{ nodes{{ ... on ProjectV2SingleSelectField {{ id name }} }} }} }} }} }}"
    );
    let out = run_gh(&["api", "graphql", "-f", &format!("query={q}")])?;
    let v: Value = serde_json::from_str(&out).context("解析字段查询失败")?;
    let field_id = v
        .pointer(&format!("/data/{owner_field}/projectV2/fields/nodes"))
        .and_then(Value::as_array)
        .and_then(|ns| {
            ns.iter().find(|n| {
                n.get("name")
                    .and_then(Value::as_str)
                    .map(|m| m.eq_ignore_ascii_case(field_name))
                    .unwrap_or(false)
            })
        })
        .and_then(|n| n.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("线上项目没有名为 {field_name} 的字段"))?;

    // ② 整表替换选项
    let opts = options
        .iter()
        .map(|(name, color, desc)| {
            serde_json::json!({
                "name": name,
                "color": color,
                "description": desc.clone().unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    let payload = serde_json::json!({
        "query": "mutation($input: UpdateProjectV2FieldInput!){ updateProjectV2Field(input: $input){ projectV2Field { ... on ProjectV2SingleSelectField { id } } } }",
        "variables": { "input": { "fieldId": field_id, "singleSelectOptions": opts } }
    });
    let body = serde_json::to_string(&payload).context("序列化发布请求失败")?;
    let out = run_gh_stdin(&["api", "graphql", "--input", "-"], &body).map_err(|e| {
        let msg = e.to_string();
        if msg.contains("scope") || msg.contains("INSUFFICIENT_SCOPES") {
            anyhow::anyhow!(
                "发布列需要 gh 令牌的 project 权限：执行 `gh auth refresh -h github.com -s project` 后重试"
            )
        } else {
            e
        }
    })?;
    if let Ok(v2) = serde_json::from_str::<Value>(&out) {
        if let Some(errs) = v2.get("errors") {
            let msg = errs
                .as_array()
                .and_then(|a| a.first())
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("未知 GraphQL 错误");
            if msg.contains("project") && (msg.contains("scope") || msg.contains("INSUFFICIENT")) {
                anyhow::bail!("发布列需要 project 写权限：请为 gh 令牌补 project scope 后重试");
            }
            anyhow::bail!("发布列失败：{msg}");
        }
    }
    Ok(())
}

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

/// 从 `gh issue create` 的输出（issue URL）解析编号。
fn parse_created_number(output: &str) -> Option<String> {
    output
        .trim()
        .rsplit('/')
        .next()
        .and_then(|tail| tail.split('?').next())
        .and_then(|tail| tail.split('#').next())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// 截止日期归一：裸日期（yyyy-mm-dd）补 T00:00:00Z 成 GitHub 要求的
/// RFC3339；其余原样。
pub(crate) fn normalize_due_date(d: &str) -> String {
    if d.len() == 10 && d.as_bytes()[4] == b'-' {
        format!("{d}T00:00:00Z")
    } else {
        d.to_string()
    }
}

/// 创建 Issue：gh issue create → 解析编号 → view 取全量实体。
fn create_issue(slug: &str, title: &str, body: Option<&str>, milestone: Option<&str>, labels: &[String], assignees: &[String]) -> Result<Issue> {
    let mut args = vec![
        "issue".to_string(),
        "create".to_string(),
        "-R".to_string(),
        slug.to_string(),
        "--title".to_string(),
        title.to_string(),
    ];
    if let Some(b) = body {
        args.push("--body".to_string());
        args.push(b.to_string());
    }
    if let Some(m) = milestone {
        args.push("--milestone".to_string());
        args.push(m.to_string());
    }
    // gh 的 --label/--assignee 接受逗号分隔清单
    if !labels.is_empty() {
        args.push("--label".to_string());
        args.push(labels.join(","));
    }
    if !assignees.is_empty() {
        args.push("--assignee".to_string());
        args.push(assignees.join(","));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_gh(&arg_refs)?;
    let number = parse_created_number(&out).ok_or_else(|| anyhow!("无法从创建输出解析编号: {}", out.trim()))?;
    let args = ["issue", "view", &number, "--repo", slug, "--json", ISSUE_LIST_FIELDS];
    let stdout = run_gh(&args)?;
    let value: Value = serde_json::from_str(&stdout).context("解析 gh issue view 的 JSON 输出失败")?;
    Ok(parse_issue_value(&value))
}

/// 仓库标签清单（创建 Issue 侧栏候选）。
fn list_labels(slug: &str) -> Result<Vec<crate::models::LabelInfo>> {
    let args = ["api", &format!("repos/{slug}/labels?per_page=100")];
    let out = run_gh(&args)?;
    let values: Vec<Value> = serde_json::from_str(&out).context("解析标签清单失败")?;
    Ok(values
        .iter()
        .map(|v| crate::models::LabelInfo {
            id: v.get("id").and_then(Value::as_i64).unwrap_or(0),
            name: v.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
            color: v.get("color").and_then(Value::as_str).map(str::to_string),
        })
        .collect())
}

/// 可指派用户清单（创建 Issue 侧栏候选）。
fn list_assignees(slug: &str) -> Result<Vec<String>> {
    let args = ["api", &format!("repos/{slug}/assignees?per_page=100"), "--jq", ".[].login"];
    let out = run_gh(&args)?;
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
}

/// 新建仓库标签（GitHub 色值不带 # 前缀）。
fn create_label(slug: &str, name: &str, color: &str) -> Result<crate::models::LabelInfo> {
    let args = [
        "api",
        "--method",
        "POST",
        &format!("repos/{slug}/labels"),
        "-f",
        &format!("name={}", name.trim()),
        "-f",
        &format!("color={}", color.trim_start_matches('#')),
    ];
    let out = run_gh(&args)?;
    let value: Value = serde_json::from_str(&out).context("解析标签创建响应失败")?;
    Ok(crate::models::LabelInfo {
        id: value.get("id").and_then(Value::as_i64).unwrap_or(0),
        name: value.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
        color: value.get("color").and_then(Value::as_str).map(str::to_string),
    })
}

/// issue view 回读全量（三个 update_* 写穿透共用）。
fn view_issue(slug: &str, number: &str) -> Result<Issue> {
    let args = ["issue", "view", number, "--repo", slug, "--json", ISSUE_LIST_FIELDS];
    let stdout = run_gh(&args)?;
    let value: Value = serde_json::from_str(&stdout).context("解析 gh issue view 的 JSON 输出失败")?;
    Ok(parse_issue_value(&value))
}

/// 编辑 Issue 标题/正文：gh issue edit → issue view 回读全量（写穿透）。
fn update_issue(slug: &str, number: &str, title: &str, body: Option<&str>) -> Result<Issue> {
    let mut args = vec![
        "issue".to_string(),
        "edit".to_string(),
        number.to_string(),
        "-R".to_string(),
        slug.to_string(),
        "--title".to_string(),
        title.trim().to_string(),
    ];
    if let Some(b) = body {
        args.push("--body".to_string());
        args.push(b.trim().to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_gh(&arg_refs)?;
    view_issue(slug, number)
}

/// 挂/清里程碑：gh issue edit --milestone（空串 = 清除）→ 回读。
fn update_issue_milestone(slug: &str, number: &str, milestone: Option<&str>) -> Result<Issue> {
    let name = milestone.map(str::trim).unwrap_or_default();
    run_gh(&["issue", "edit", number, "--repo", slug, "--milestone", name])?;
    view_issue(slug, number)
}

/// 整体替换标签：PUT issues/{n}/labels（gh api 数组字段）→ 回读。
fn update_issue_labels(slug: &str, number: &str, labels: &[String]) -> Result<Issue> {
    if labels.is_empty() {
        run_gh(&[
            "api",
            "--method",
            "PUT",
            &format!("repos/{slug}/issues/{number}/labels"),
            "-F",
            "labels=[]",
        ])?;
    } else {
        let mut args = vec![
            "api".to_string(),
            "--method".to_string(),
            "PUT".to_string(),
            format!("repos/{slug}/issues/{number}/labels"),
        ];
        for l in labels {
            if !l.trim().is_empty() {
                args.push("-f".to_string());
                args.push(format!("labels[]={}", l.trim()));
            }
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_gh(&arg_refs)?;
    }
    view_issue(slug, number)
}

/// 整体替换负责人：PUT issues/{n}/assignees → 回读。
fn update_issue_assignees(slug: &str, number: &str, assignees: &[String]) -> Result<Issue> {
    if assignees.is_empty() {
        run_gh(&[
            "api",
            "--method",
            "DELETE",
            &format!("repos/{slug}/issues/{number}/assignees"),
            "-F",
            "assignees=[]",
        ])?;
    } else {
        let mut args = vec![
            "api".to_string(),
            "--method".to_string(),
            "PUT".to_string(),
            format!("repos/{slug}/issues/{number}/assignees"),
        ];
        for a in assignees {
            if !a.trim().is_empty() {
                args.push("-f".to_string());
                args.push(format!("assignees[]={}", a.trim()));
            }
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_gh(&arg_refs)?;
    }
    view_issue(slug, number)
}

/// 创建 PR：gh pr create → 解析编号 → pr view 取全量。
fn create_pull(slug: &str, head: &str, base: &str, title: &str, body: Option<&str>) -> Result<Pull> {
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        "-R".to_string(),
        slug.to_string(),
        "--head".to_string(),
        head.to_string(),
        "--base".to_string(),
        base.to_string(),
        "--title".to_string(),
        title.to_string(),
    ];
    if let Some(b) = body {
        args.push("--body".to_string());
        args.push(b.to_string());
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_gh(&arg_refs)?;
    let number = parse_created_number(&out).ok_or_else(|| anyhow!("无法从创建输出解析编号: {}", out.trim()))?;
    fetch_pull_detail(slug, &number)
}

/// 里程碑元数据清单（state=all 含已关闭）。
fn list_milestones(slug: &str) -> Result<Vec<crate::models::MilestoneInfo>> {
    let args = ["api", &format!("repos/{slug}/milestones?state=all&per_page=100")];
    let out = run_gh(&args)?;
    let values: Vec<Value> = serde_json::from_str(&out).context("解析里程碑清单失败")?;
    Ok(values.iter().map(parse_milestone_value).collect())
}

/// 里程碑 REST JSON → MilestoneInfo（清单与写穿透回读共用）。
fn parse_milestone_value(v: &Value) -> crate::models::MilestoneInfo {
    crate::models::MilestoneInfo {
        number: v.get("number").and_then(Value::as_i64).unwrap_or(0),
        title: v.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
        description: v.get("description").and_then(Value::as_str).map(str::to_string),
        due_on: v.get("due_on").and_then(Value::as_str).map(str::to_string),
        state: v.get("state").and_then(Value::as_str).unwrap_or("open").to_string(),
        open_issues: v.get("open_issues").and_then(Value::as_i64).unwrap_or(0),
        closed_issues: v.get("closed_issues").and_then(Value::as_i64).unwrap_or(0),
        html_url: v.get("html_url").and_then(Value::as_str).map(str::to_string),
    }
}

/// 切换里程碑开启/关闭：PATCH state → 返回平台确认的全量元数据。
fn set_milestone_state(slug: &str, number: i64, closed: bool) -> Result<crate::models::MilestoneInfo> {
    let args = [
        "api",
        "--method",
        "PATCH",
        &format!("repos/{slug}/milestones/{number}"),
        "-f",
        &format!("state={}", if closed { "closed" } else { "open" }),
    ];
    let out = run_gh(&args)?;
    let value: Value = serde_json::from_str(&out).context("解析里程碑状态更新响应失败")?;
    Ok(parse_milestone_value(&value))
}

/// 编辑里程碑名称/描述/截止日：PATCH → 返回平台确认的全量元数据。
fn update_milestone(
    slug: &str,
    number: i64,
    title: &str,
    description: Option<&str>,
    due_on: Option<&str>,
) -> Result<crate::models::MilestoneInfo> {
    let mut args = vec![
        "api".to_string(),
        "--method".to_string(),
        "PATCH".to_string(),
        format!("repos/{slug}/milestones/{number}"),
        "-f".to_string(),
        format!("title={}", title.trim()),
    ];
    if let Some(d) = description {
        args.push("-f".to_string());
        args.push(format!("description={}", d.trim()));
    }
    if let Some(d) = due_on {
        args.push("-f".to_string());
        args.push(format!("due_on={}", normalize_due_date(d)));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_gh(&arg_refs)?;
    let value: Value = serde_json::from_str(&out).context("解析里程碑编辑响应失败")?;
    Ok(parse_milestone_value(&value))
}

/// 创建里程碑本体（gh api POST 表单字段）。
fn create_milestone(slug: &str, title: &str, due_on: Option<&str>, description: Option<&str>) -> Result<String> {
    let mut args = vec![
        "api".to_string(),
        format!("repos/{slug}/milestones"),
        "-f".to_string(),
        format!("title={title}"),
    ];
    if let Some(d) = due_on {
        args.push("-f".to_string());
        args.push(format!("due_on={}", normalize_due_date(d)));
    }
    if let Some(desc) = description {
        args.push("-f".to_string());
        args.push(format!("description={desc}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_gh(&arg_refs)?;
    let value: Value = serde_json::from_str(&out).context("解析里程碑创建响应失败")?;
    Ok(value
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or(title)
        .to_string())
}

/// 远端分支名清单（PR 创建表单候选）。
fn remote_branches(slug: &str) -> Result<Vec<String>> {
    let args = ["api", &format!("repos/{slug}/branches"), "--jq", ".[].name"];
    let out = run_gh(&args)?;
    Ok(out.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
}

/// Close or reopen an issue; returns the fresh entity for store patching.
/// reason ∈ completed | "not planned" | duplicate（gh issue close -r）。
fn set_issue_state(slug: &str, number: &str, closed: bool, reason: Option<&str>) -> Result<Issue> {
    if closed {
        let mut args = vec![
            "issue".to_string(),
            "close".to_string(),
            number.to_string(),
            "--repo".to_string(),
            slug.to_string(),
        ];
        if let Some(r) = reason.map(str::trim).filter(|s| !s.is_empty()) {
            args.push("-r".to_string());
            args.push(r.to_string());
        }
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        run_gh(&arg_refs)?;
    } else {
        run_gh(&["issue", "reopen", number, "--repo", slug])?;
    }
    view_issue(slug, number)
}

/// 锁定/解锁讨论：REST issues/{n}/lock（PUT 上锁、DELETE 解锁）。
fn set_issue_locked(slug: &str, number: &str, locked: bool) -> Result<()> {
    if locked {
        run_gh(&["api", "--method", "PUT", &format!("repos/{slug}/issues/{number}/lock")])?;
    } else {
        run_gh(&["api", "--method", "DELETE", &format!("repos/{slug}/issues/{number}/lock")])?;
    }
    Ok(())
}

/// 删除 Issue：REST DELETE（需仓库管理员，204 即成功）。
fn delete_issue(slug: &str, number: &str) -> Result<()> {
    run_gh(&["api", "--method", "DELETE", &format!("repos/{slug}/issues/{number}")])?;
    Ok(())
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

    /// 关系解析（GraphQL 输出形状）：四类齐全 → 全量映射，state 取原样。
    #[test]
    fn relations_parse_full_shape() {
        let v: Value = serde_json::from_str(
            r#"{
              "blockedBy": {"nodes": [{"number": 7, "title": "阻塞者", "state": "OPEN"}]},
              "blocking": {"nodes": [{"number": 9, "title": "被阻塞", "state": "CLOSED"}]},
              "parent": {"number": 3, "title": "父", "state": "OPEN"},
              "subIssues": {"nodes": [{"number": 11, "title": "子", "state": "OPEN"}]},
              "subIssuesSummary": {"total": 2, "completed": 1}
            }"#,
        )
        .unwrap();
        let r = parse_relations_value(&v);
        assert_eq!(r.blocked_by.len(), 1);
        assert_eq!(r.blocked_by[0].number, "7");
        assert_eq!(r.blocking[0].state, "CLOSED");
        assert_eq!(r.parent.unwrap().title, "父");
        assert_eq!(r.sub_issues.len(), 1);
        let s = r.sub_summary.unwrap();
        assert_eq!((s.total, s.completed), (2, 1));
    }

    /// 空关系（无依赖/无父子）：nodes 空数组 + summary 0/0 → 全空。
    /// summary total=0 不出进度（前端不显示「0/0」）。
    #[test]
    fn relations_parse_empty_shape() {
        let v: Value = serde_json::from_str(
            r#"{"blockedBy": {"nodes": []}, "blocking": {"nodes": []},
                "parent": null, "subIssues": {"nodes": []},
                "subIssuesSummary": {"total": 0, "completed": 0}}"#,
        )
        .unwrap();
        let r = parse_relations_value(&v);
        assert!(r.blocked_by.is_empty() && r.blocking.is_empty());
        assert!(r.parent.is_none() && r.sub_issues.is_empty());
        assert!(r.sub_summary.is_none());
    }

    /// 节点缺 title/state 时诚实兜底（空串/OPEN），不 panic。
    #[test]
    fn relations_parse_missing_fields() {
        let v: Value = serde_json::from_str(
            r#"{"blockedBy": {"nodes": [{"number": 5}]}}"#,
        )
        .unwrap();
        let r = parse_relations_value(&v);
        assert_eq!(r.blocked_by[0].number, "5");
        assert_eq!(r.blocked_by[0].title, "");
        assert_eq!(r.blocked_by[0].state, "OPEN");
    }

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
    fn normalize_due_date_appends_time() {
        assert_eq!(normalize_due_date("2026-10-01"), "2026-10-01T00:00:00Z");
        assert_eq!(normalize_due_date("2026-10-01T08:00:00Z"), "2026-10-01T08:00:00Z");
    }

    #[test]
    fn parse_created_number_from_url_output() {
        assert_eq!(
            parse_created_number("https://github.com/o/r/issues/123"),
            Some("123".to_string())
        );
        assert_eq!(
            parse_created_number("https://github.com/o/r/pull/45?ref=abc"),
            Some("45".to_string())
        );
        assert_eq!(parse_created_number(""), None);
    }

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

// ---- GitHub OAuth Device Flow（分发期认证 GUI；凭据仍归 gh 托管）----
// 知识库《从只读到读写》L20 定案：自实现 Device Flow 拿 token，
// `gh auth login --with-token` 喂入 gh 自己的凭据库，本应用不存。
// client_id 用 cli/cli 的公开 id（喂入 gh 后其签发的凭据对 gh 全兼容）。

const GH_DEVICE_CLIENT_ID: &str = "178c6fc778ccc68e1d6a";
const GH_DEVICE_SCOPES: &str = "repo,read:org,gist,workflow";
const GH_DEVICE_TIMEOUT_SECS: u64 = 180;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFlowStart {
    pub user_code: String,
    pub verification_uri: String,
    pub device_code: String,
    pub interval_secs: u64,
}

fn device_http_client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("HiveTask")
        .build()
        .context("构建 HTTP 客户端失败")
}

/// 第一步：申请设备码 + 用户码。
pub fn device_flow_start() -> Result<DeviceFlowStart> {
    let client = device_http_client()?;
    let resp: Value = client
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", GH_DEVICE_CLIENT_ID),
            ("scope", GH_DEVICE_SCOPES),
        ])
        .send()?
        .error_for_status()?
        .json()?;
    Ok(DeviceFlowStart {
        user_code: resp.get("user_code").and_then(Value::as_str).ok_or_else(|| anyhow!("GitHub 响应缺少 user_code"))?.to_string(),
        verification_uri: resp.get("verification_uri").and_then(Value::as_str).unwrap_or("https://github.com/login/device").to_string(),
        device_code: resp.get("device_code").and_then(Value::as_str).ok_or_else(|| anyhow!("GitHub 响应缺少 device_code"))?.to_string(),
        interval_secs: resp.get("interval").and_then(Value::as_u64).unwrap_or(5).max(3),
    })
}

/// 第二步：阻塞轮询令牌（authorization_pending 静默重试、slow_down +5s、
/// 其余 error 诚实失败；总超时后明确报错）。
pub fn device_flow_poll(device_code: &str, interval_secs: u64) -> Result<String> {
    let client = device_http_client()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(GH_DEVICE_TIMEOUT_SECS);
    let mut interval = interval_secs.max(1);
    loop {
        std::thread::sleep(std::time::Duration::from_secs(interval));
        if std::time::Instant::now() > deadline {
            return Err(anyhow!("授权等待超时，请重新发起登录"));
        }
        let resp: Value = client
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .form(&[
                ("client_id", GH_DEVICE_CLIENT_ID),
                ("device_code", device_code),
                (
                    "grant_type",
                    "urn:ietf:params:oauth:grant-type:device_code",
                ),
            ])
            .send()?
            .error_for_status()?
            .json()?;
        if let Some(token) = resp.get("access_token").and_then(Value::as_str) {
            return Ok(token.to_string());
        }
        match resp.get("error").and_then(Value::as_str) {
            Some("authorization_pending") => {}
            Some("slow_down") => interval += 5,
            Some(other) => return Err(anyhow!("GitHub 授权失败: {other}")),
            None => return Err(anyhow!("GitHub 授权响应异常")),
        }
    }
}

/// 把 token 喂进 gh 自己的凭据库（`gh auth login --with-token`），并
/// 以 `gh api user` 校验登录态；凭据后续由 gh 托管，本应用不经手。
pub fn auth_with_token(token: &str) -> Result<String> {
    let gh = find_gh().ok_or_else(|| anyhow!("找不到 gh CLI"))?;
    use std::io::Write as _;
    let mut child = Command::new(gh)
        .args(["auth", "login", "--with-token"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("启动 gh 失败")?;
    child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("无法写入 gh 标准输入"))?
        .write_all(token.as_bytes())
        .context("写入 token 失败")?;
    let out = child.wait_with_output().context("等待 gh 退出失败")?;
    if !out.status.success() {
        return Err(anyhow!(
            "{}",
            String::from_utf8_lossy(&out.stderr).trim().to_string()
        ));
    }
    auth_user().ok_or_else(|| anyhow!("token 已写入但登录校验失败"))
}

/// 当前 gh 登录名（未登录 / gh 缺失 → None）。
pub fn auth_user() -> Option<String> {
    let gh = find_gh()?;
    let output = Command::new(gh)
        .args(["api", "user", "--jq", ".login"])
        .output()
        .ok()?;
    if output.status.success() {
        let login = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if login.is_empty() { None } else { Some(login) }
    } else {
        None
    }
}
