//! GitHub data source: shells out to the `gh` CLI. Keeping gh as a side
//! process means auth (the token stored in ~/.config/gh) and API channel
//! access come for free.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

use crate::models::Issue;

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

    let mut issues = Vec::with_capacity(values.len());
    for v in values {
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

        issues.push(Issue {
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
        });
    }
    Ok(issues)
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
}
