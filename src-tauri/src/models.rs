//! Data models shared by the GitHub provider, storage layer and Tauri commands.
//!
//! Field names serialize to camelCase to match the TypeScript frontend.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: i64,
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
}
