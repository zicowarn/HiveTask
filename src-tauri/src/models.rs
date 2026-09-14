//! Data models shared by the GitHub provider, storage layer and Tauri commands.
//!
//! Field names serialize to camelCase to match the TypeScript frontend.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// 平台原样编号：GitHub/Gitea 为十进制文本，Gitee v5 为 "IKCTH7" 形态
    /// 字符串（缓存列已同步 TEXT，见 migration 006）。
    pub number: String,
    pub title: String,
    /// GitHub state as returned by `gh`: "OPEN" | "CLOSED".
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pull {
    pub number: i64,
    pub title: String,
    /// GitHub state as returned by `gh`: "OPEN" | "CLOSED" | "MERGED".
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default)]
    pub reviewers: Vec<String>,
    /// gh `reviewDecision`: "APPROVED" | "REVIEW_REQUIRED" | "CHANGES_REQUESTED", …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_decision: Option<String>,
    #[serde(default)]
    pub additions: i64,
    #[serde(default)]
    pub deletions: i64,
    #[serde(default)]
    pub commits: i64,
    #[serde(default)]
    pub comments: i64,
    #[serde(default)]
    pub is_draft: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthInfo {
    pub gh_available: bool,
    pub gh_path: Option<String>,
    pub gh_version: Option<String>,
}

// ---- Tools workspace: git history & branches ----

/// One commit for the history graph (mirrors @web-git-graph's DTO shape;
/// the frontend converts committedAtUnix to ISO before rendering).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRow {
    pub oid: String,
    pub parents: Vec<String>,
    pub message: String,
    pub author: Option<String>,
    pub committed_at_unix: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefRow {
    pub name: String,
    pub target: String,
    /// "head" | "remote" | "current" (GitGraphRefKind subset)
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryPage {
    pub commits: Vec<CommitRow>,
    pub refs: Vec<GitRefRow>,
    pub head: Option<String>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRow {
    pub name: String,
    pub is_remote: bool,
    pub is_current: bool,
    pub short_id: Option<String>,
    pub ahead: i64,
    pub behind: i64,
}

/// 里程碑元数据（list_milestones：PR/看板组头与截止提醒的数据源）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MilestoneInfo {
    pub title: String,
    /// RFC3339 截止时间；未设 → None。
    pub due_on: Option<String>,
    /// "open" | "closed"。
    pub state: String,
    /// 平台口径的计数（完成度不随前端筛选变化）。
    pub open_issues: i64,
    pub closed_issues: i64,
}

// ---- 本地分支 review（设计：《本地Issue与本地分支Review》Q3）----

/// 相对 base 的分支条目（领先/落后计数；分支名即意图声明，无实体表）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewBranch {
    pub name: String,
    pub is_current: bool,
    pub ahead: i64,
    pub behind: i64,
    pub short_id: String,
}

/// diff 单文件：状态 + 行统计 + unified patch 文本（v1 单栏着色，无 side-by-side）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    /// added | modified | deleted | renamed
    pub status: String,
    pub additions: i64,
    pub deletions: i64,
    pub patch: Option<String>,
}

/// 一次分支 review 的全部预览数据（提交 + 文件 diff + 可合并性）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchReviewDiff {
    pub base: String,
    pub head: String,
    /// head 已完全包含在 base 中（无事可合并）。
    pub up_to_date: bool,
    /// 可干净合并（非 up_to_date 且无冲突）。
    pub mergeable: bool,
    /// 存在冲突——红线：不提供解决 UI，诚实提示去终端/编辑器。
    pub conflict: bool,
    pub commits: Vec<CommitRow>,
    pub files: Vec<ReviewFile>,
    /// patch 总量超限被截断（防大 diff 拖垮 webview）。
    pub truncated: bool,
}

/// One conversation comment on an issue or PR.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub author: Option<String>,
    pub body: Option<String>,
    pub created_at: Option<String>,
    /// Frontend-only marker for the optimistic pending row; never set by Rust.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pending: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub path: String,
    /// Output of `git remote get-url origin`, if it exists.
    pub origin: Option<String>,
    /// Path exists on disk — guards against stale persisted repo paths
    /// (e.g. a demo clone under /tmp removed by periodic cleanup).
    pub valid: bool,
    /// 来源路由口径（与运行时同一条链：登记连接显式 > host 推断）；
    /// None = 无 remote 或来源未知（前端显示「本地」）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
}
