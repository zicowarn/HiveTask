//! GitHub data source: shells out to the `gh` CLI. Keeping gh as a side
//! process means auth (the token stored in ~/.config/gh) and API channel
//! access come for free.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

use crate::models::{Comment, Issue, Pull};

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
fn run_gh(repo: &Path, args: &[&str]) -> Result<String> {
    let gh = find_gh().ok_or_else(|| {
        anyhow!("找不到 gh CLI，请先安装并执行 `gh auth login`（macOS: brew install gh）")
    })?;

    let output = Command::new(gh)
        .args(args)
        .current_dir(repo)
        .output()
        .with_context(|| format!("启动 gh 失败（工作目录: {}）", repo.display()))?;

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

/// Fetch issues via `gh issue list`. `state` is "open" | "closed" | "all".
pub fn fetch_issues(repo: &Path, state: &str, limit: u32) -> Result<Vec<Issue>> {
    let limit = limit.clamp(1, 1000).to_string();
    let args = [
        "issue",
        "list",
        "--json",
        ISSUE_LIST_FIELDS,
        "--state",
        state,
        "--limit",
        &limit,
    ];
    let stdout = run_gh(repo, &args)?;
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
        body: string_field(&v, "body"),
        author: v.get("author").and_then(|a| a.get("login")).and_then(Value::as_str).map(str::to_string),
        milestone: v
            .get("milestone")
            .and_then(|m| m.get("title"))
            .and_then(Value::as_str)
            .map(str::to_string),
        labels,
        assignees,
        created_at: string_field(&v, "createdAt"),
        updated_at: string_field(&v, "updatedAt"),
        url: string_field(&v, "url"),
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
pub fn fetch_pulls(repo: &Path, state: &str, limit: u32) -> Result<Vec<Pull>> {
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
        "pr",
        "list",
        "--json",
        PR_LIST_FIELDS,
        "--state",
        state,
        "--limit",
        &fetch_limit,
    ];
    let stdout = run_gh(repo, &args)?;
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
pub fn fetch_pull_detail(repo: &Path, number: i64) -> Result<Pull> {
    let fields = format!("{PR_LIST_FIELDS},{PR_DETAIL_FIELDS}");
    let number_str = number.to_string();
    let args = ["pr", "view", &number_str, "--json", &fields];
    let stdout = run_gh(repo, &args)?;
    let value: Value =
        serde_json::from_str(&stdout).context("解析 gh pr view 的 JSON 输出失败")?;
    Ok(parse_pull_value(&value))
}

// ---- Mutations & conversations (the P1 write-through surface) ----

/// Fetch an entity's conversation comments via `gh issue|pr view --json
/// comments`. `kind` is "issue" | "pull" (the gh subcommand).
pub fn fetch_comments(repo: &Path, kind: &str, number: i64) -> Result<Vec<Comment>> {
    let number_str = number.to_string();
    let args = [kind, "view", &number_str, "--json", "comments"];
    let stdout = run_gh(repo, &args)?;
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
pub fn add_comment(repo: &Path, kind: &str, number: i64, body: &str) -> Result<Vec<Comment>> {
    let number_str = number.to_string();
    let args = [kind, "comment", &number_str, "--body", body];
    run_gh(repo, &args)?;
    fetch_comments(repo, kind, number)
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
pub fn set_issue_state(repo: &Path, number: i64, closed: bool) -> Result<Issue> {
    let number_str = number.to_string();
    let verb = if closed { "close" } else { "reopen" };
    let args = ["issue", verb, &number_str];
    run_gh(repo, &args)?;
    let args = ["issue", "view", &number_str, "--json", ISSUE_LIST_FIELDS];
    let stdout = run_gh(repo, &args)?;
    let value: Value =
        serde_json::from_str(&stdout).context("解析 gh issue view 的 JSON 输出失败")?;
    Ok(parse_issue_value(&value))
}

/// Close or reopen a pull request; returns the fresh full record so a close
/// that raced a merge surfaces as MERGED, not CLOSED.
pub fn set_pull_state(repo: &Path, number: i64, closed: bool) -> Result<Pull> {
    let number_str = number.to_string();
    let verb = if closed { "close" } else { "reopen" };
    let args = ["pr", verb, &number_str];
    run_gh(repo, &args)?;
    fetch_pull_detail(repo, number)
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
        assert_eq!(first.number, 42);
        assert_eq!(first.state, "OPEN");
        assert_eq!(first.author.as_deref(), Some("zicowarn"));
        assert_eq!(first.labels, vec!["bug", "ui"]);
        assert_eq!(first.milestone.as_deref(), Some("v1.0"));
        assert_eq!(first.assignees, vec!["zicowarn"]);

        let second = &issues[1];
        assert_eq!(second.number, 41);
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
