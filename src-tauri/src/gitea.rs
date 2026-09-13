//! Gitea 来源实现（reqwest + token）——「局域网团队」场景，兼验 Source
//! trait 的设计（设计文档 Q4：Gitea API 刻意仿 GitHub，接入成本低）。
//!
//! 方言对照（相对 gh）：
//! - 实体编号叫 index（API 路径），但数值语义与 number 相同；
//! - PR 状态小写 open/closed，已合并看 `merged` 布尔字段；
//! - 合并方式是 body 里的 `Do` 字段（merge/squash/rebase/rebase-merge）；
//! - 评论端点对 issue 与 PR 通用（/issues/{index}/comments）。
//!
//! 认证：`Authorization: token <TOKEN>` 头。网络与鉴权错误原文上抛，
//! 归一化错误码（trait 推论 2）在后续步骤接入。

use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::time::Duration;

use crate::models::{Comment, Issue, Pull};
use crate::source::{IssueStateFilter, Kind, MergeMethod, PullStateFilter, RepoRef, Source};

pub struct GiteaSource {
    /// gitea | gitee（决定 API 前缀 v1/v5、认证头与合并方言）。
    platform: String,
    /// 实例地址，如 "https://gitea.example.com"（不带尾斜杠）。
    host: String,
    token: Option<String>,
}

struct RepoSlug {
    owner: String,
    repo: String,
}

impl GiteaSource {
    pub fn new(platform: String, host: String, token: Option<String>) -> Self {
        Self {
            platform,
            host: host.trim_end_matches('/').to_string(),
            token,
        }
    }

    /// API 前缀：Gitea /api/v1，Gitee /api/v5。
    fn api_prefix(&self) -> &'static str {
        match self.platform.as_str() {
            "gitee" => "/api/v5",
            _ => "/api/v1",
        }
    }

    fn api(&self, path: &str) -> String {
        format!("{}{}{}", self.host, self.api_prefix(), path)
    }

    fn client(&self) -> reqwest::blocking::Client {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("HiveTask")
            .build()
            .unwrap_or_default()
    }

    fn attach_auth(&self, req: reqwest::blocking::RequestBuilder) -> reqwest::blocking::RequestBuilder {
        match &self.token {
            // Gitea 惯用 `token` 前缀；Gitee v5 两者皆收，统一 Bearer。
            Some(token) if self.platform == "gitea" => {
                req.header("Authorization", format!("token {token}"))
            }
            Some(token) => req.bearer_auth(token),
            None => req,
        }
    }

    fn get(&self, url: &str) -> Result<Value> {
        let resp = self.attach_auth(self.client().get(url)).send().context("Gitea 请求失败")?;
        let status = resp.status();
        let body = resp.text().context("读取 Gitea 响应失败")?;
        if !status.is_success() {
            return Err(anyhow!("Gitea {} : {}", status, body.trim()));
        }
        Ok(serde_json::from_str(&body).unwrap_or(Value::Null))
    }

    fn send_json(&self, method: reqwest::Method, url: &str, json: Value) -> Result<Value> {
        let resp = self.attach_auth(self.client().request(method, url).json(&json)).send().context("Gitea 请求失败")?;
        let status = resp.status();
        let body = resp.text().context("读取 Gitea 响应失败")?;
        if !status.is_success() {
            return Err(anyhow!("Gitea {} : {}", status, body.trim()));
        }
        Ok(serde_json::from_str(&body).unwrap_or(Value::Null))
    }

    /// RepoRef → 常驻 slug（owner/repo 已在解析期确定，无需再读盘）。
    fn slug_ref(&self, repo: &RepoRef) -> RepoSlug {
        RepoSlug { owner: repo.owner.clone(), repo: repo.repo.clone() }
    }

    fn issues_url(&self, slug: &RepoSlug, filter: IssueStateFilter, limit: u32) -> String {
        let state = match filter {
            IssueStateFilter::Open => "open",
            IssueStateFilter::Closed => "closed",
            IssueStateFilter::All => "all",
        };
        self.api(&format!(
            "/repos/{}/{}/issues?type=issues&state={state}&limit={limit}",
            slug.owner, slug.repo
        ))
    }

    fn pulls_url(&self, slug: &RepoSlug, filter: PullStateFilter, limit: u32) -> String {
        let state = match filter {
            PullStateFilter::Open => "open",
            PullStateFilter::Closed => "closed",
            PullStateFilter::Merged => "closed",
            PullStateFilter::All => "all",
        };
        self.api(&format!(
            "/repos/{}/{}/pulls?state={state}&limit={limit}",
            slug.owner, slug.repo
        ))
    }
}

// ---- JSON 方言映射（纯函数，可测） ----

pub(crate) fn map_gitea_issue(v: &Value) -> Issue {
    Issue {
        // Gitee v5 的 issue number 是字符串（"IKCTH7"），Gitea 是整数——
        // 统一文本口径（此前 as_i64 对 Gitee 静默变 0）。
        number: crate::source::json_number_to_string(v.get("number")),
        title: v.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
        state: match v.get("state").and_then(Value::as_str) {
            Some("closed") => "CLOSED",
            _ => "OPEN",
        }
        .to_string(),
        body: v.get("body").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
        author: v
            .pointer("/user/login")
            .and_then(Value::as_str)
            .map(str::to_string),
        milestone: v.pointer("/milestone/title").and_then(Value::as_str).map(str::to_string),
        labels: v
            .get("labels")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|l| l.get("name").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        assignees: v
            .get("assignees")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|u| u.get("login").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        created_at: v.get("created_at").and_then(Value::as_str).map(str::to_string),
        updated_at: v.get("updated_at").and_then(Value::as_str).map(str::to_string),
        url: v.get("html_url").and_then(Value::as_str).map(str::to_string),
    }
}

pub(crate) fn map_gitea_pull(v: &Value) -> Pull {
    let merged = v.get("merged").and_then(Value::as_bool).unwrap_or(false);
    Pull {
        number: v.get("number").and_then(Value::as_i64).unwrap_or_default(),
        title: v.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
        state: if merged { "MERGED" } else { match v.get("state").and_then(Value::as_str) {
            Some("closed") => "CLOSED",
            _ => "OPEN",
        } }
        .to_string(),
        body: v.get("body").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
        author: v
            .pointer("/user/login")
            .and_then(Value::as_str)
            .map(str::to_string),
        head_ref: v.pointer("/head/ref").and_then(Value::as_str).map(str::to_string),
        base_ref: v.pointer("/base/ref").and_then(Value::as_str).map(str::to_string),
        labels: v
            .get("labels")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|l| l.get("name").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        assignees: v
            .get("assignees")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|u| u.get("login").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        reviewers: vec![],
        review_decision: None,
        additions: v.get("additions").and_then(Value::as_i64).unwrap_or_default(),
        deletions: v.get("deletions").and_then(Value::as_i64).unwrap_or_default(),
        commits: 0,
        comments: v.get("comments").and_then(Value::as_i64).unwrap_or_default(),
        is_draft: v.get("draft").and_then(Value::as_bool).unwrap_or(false),
        created_at: v.get("created_at").and_then(Value::as_str).map(str::to_string),
        updated_at: v.get("updated_at").and_then(Value::as_str).map(str::to_string),
        url: v.get("html_url").and_then(Value::as_str).map(str::to_string),
    }
}

pub(crate) fn merge_do(method: MergeMethod) -> &'static str {
    match method {
        MergeMethod::Merge => "merge",
        MergeMethod::Squash => "squash",
        MergeMethod::Rebase => "rebase",
    }
}

pub(crate) fn map_gitea_comment(v: &Value) -> Comment {
    Comment {
        author: v
            .pointer("/user/login")
            .and_then(Value::as_str)
            .map(str::to_string),
        body: v.get("body").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
        created_at: v.get("created_at").and_then(Value::as_str).map(str::to_string),
        pending: false,
    }
}

impl GiteaSource {
    fn comments_url(&self, slug: &RepoSlug, number: &str) -> String {
        self.api(&format!("/repos/{}/{}/issues/{number}/comments", slug.owner, slug.repo))
    }
}

impl Source for GiteaSource {
    fn fetch_issues(&self, repo: &RepoRef, filter: IssueStateFilter, limit: u32) -> Result<Vec<Issue>> {
        let slug = self.slug_ref(repo);
        let url = self.issues_url(&slug, filter, limit);
        let value = self.get(&url)?;
        Ok(value
            .as_array()
            .map(|arr| arr.iter().map(map_gitea_issue).collect())
            .unwrap_or_default())
    }

    fn fetch_pulls(&self, repo: &RepoRef, filter: PullStateFilter, limit: u32) -> Result<Vec<Pull>> {
        let slug = self.slug_ref(repo);
        let url = self.pulls_url(&slug, filter, limit);
        let value = self.get(&url)?;
        let mut pulls: Vec<Pull> = value
            .as_array()
            .map(|arr| arr.iter().map(map_gitea_pull).collect())
            .unwrap_or_default();
        // 与 gh 的 Closed 语义对齐：closed 过滤不含已合并（Merged 有独立 Tab）。
        if filter == PullStateFilter::Closed {
            pulls.retain(|p| p.state != "MERGED");
        }
        Ok(pulls)
    }

    fn fetch_pull_detail(&self, repo: &RepoRef, number: &str) -> Result<Pull> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/pulls/{number}", slug.owner, slug.repo));
        let value = self.get(&url)?;
        Ok(map_gitea_pull(&value))
    }

    fn fetch_comments(&self, repo: &RepoRef, kind: Kind, number: &str) -> Result<Vec<Comment>> {
        // Gitee/Gitea 的 PR 评论走 issue 评论端点（PR 即带编号的 issue）。
        let _ = kind;
        let value = self.get(&self.comments_url(&self.slug_ref(repo), number))?;
        Ok(value
            .as_array()
            .map(|arr| arr.iter().map(map_gitea_comment).collect())
            .unwrap_or_default())
    }

    fn add_comment(&self, repo: &RepoRef, kind: Kind, number: &str, body: &str) -> Result<Vec<Comment>> {
        let slug = self.slug_ref(repo);
        let url = self.comments_url(&slug, number);
        self.send_json(reqwest::Method::POST, &url, serde_json::json!({ "body": body }))?;
        self.fetch_comments(repo, kind, number)
    }

    fn set_issue_state(&self, repo: &RepoRef, number: &str, closed: bool) -> Result<Issue> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/issues/{number}", slug.owner, slug.repo));
        let state = if closed { "closed" } else { "open" };
        let value =
            self.send_json(reqwest::Method::PATCH, &url, serde_json::json!({ "state": state }))?;
        Ok(map_gitea_issue(&value))
    }

    fn set_pull_state(&self, repo: &RepoRef, number: &str, closed: bool) -> Result<Pull> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/pulls/{number}", slug.owner, slug.repo));
        let state = if closed { "closed" } else { "open" };
        let value =
            self.send_json(reqwest::Method::PATCH, &url, serde_json::json!({ "state": state }))?;
        Ok(map_gitea_pull(&value))
    }

    fn merge_pull(&self, repo: &RepoRef, number: &str, method: MergeMethod) -> Result<Pull> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/pulls/{number}/merge", slug.owner, slug.repo));
        // 方言：Gitea 用 Do 字段；Gitee v5 用 merge_method 字段。
        let body = match self.platform.as_str() {
            "gitee" => serde_json::json!({ "merge_method": merge_do(method) }),
            _ => serde_json::json!({ "Do": merge_do(method) }),
        };
        self.send_json(reqwest::Method::POST, &url, body)?;
        self.fetch_pull_detail(repo, number)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真 Gitea API 的 issue 样本（v1 字段形态）。
    const ISSUE_SAMPLE: &str = r#"{
      "number": 42,
      "title": "nightly build fails",
      "state": "open",
      "body": "steps...",
      "user": {"login": "alice"},
      "milestone": {"title": "v1.2"},
      "labels": [{"name": "bug"}, {"name": "ui"}],
      "assignees": [{"login": "bob"}],
      "created_at": "2026-09-01T10:00:00Z",
      "updated_at": "2026-09-05T12:00:00Z",
      "html_url": "https://gitea.example.com/o/r/issues/42"
    }"#;

    const PR_SAMPLE: &str = r#"{
      "number": 17,
      "title": "Add dark mode",
      "state": "open",
      "merged": false,
      "draft": true,
      "body": "rewrite",
      "user": {"login": "carol"},
      "labels": [{"name": "ui"}],
      "assignees": [{"login": "dave"}],
      "head": {"ref": "feat/dark", "label": "o:feat/dark"},
      "base": {"ref": "main", "label": "o:main"},
      "comments": 3,
      "created_at": "2026-09-02T10:00:00Z",
      "updated_at": "2026-09-06T12:00:00Z",
      "html_url": "https://gitea.example.com/o/r/pulls/17"
    }"#;

    #[test]
    fn maps_issue_dialect() {
        let v: Value = serde_json::from_str(ISSUE_SAMPLE).unwrap();
        let issue = map_gitea_issue(&v);
        assert_eq!(issue.number, "42"); // 整数编号归一为十进制文本
        assert_eq!(issue.state, "OPEN"); // 小写方言 → GitHub 大写口径
        assert_eq!(issue.milestone.as_deref(), Some("v1.2"));
        assert_eq!(issue.labels, vec!["bug", "ui"]);
        assert_eq!(issue.author.as_deref(), Some("alice"));
        assert_eq!(issue.url.as_deref(), Some("https://gitea.example.com/o/r/issues/42"));
    }

    /// 真 Gitee v5 的 issue 样本：number 是字符串形态。
    const GITEE_ISSUE_SAMPLE: &str = r#"{
      "number": "IKCTH7",
      "title": "gitee string id",
      "state": "open",
      "user": {"login": "alice"},
      "html_url": "https://gitee.com/o/r/issues/IKCTH7"
    }"#;

    #[test]
    fn maps_gitee_string_issue_number() {
        let v: Value = serde_json::from_str(GITEE_ISSUE_SAMPLE).unwrap();
        let issue = map_gitea_issue(&v);
        // 此前 as_i64 对字符串编号静默变 0——文本口径后原样保留。
        assert_eq!(issue.number, "IKCTH7");
        assert_eq!(issue.state, "OPEN");
    }

    #[test]
    fn maps_pull_dialect_with_merged_and_draft() {
        let v: Value = serde_json::from_str(PR_SAMPLE).unwrap();
        let pull = map_gitea_pull(&v);
        assert_eq!(pull.number, 17);
        assert_eq!(pull.state, "OPEN"); // merged=false
        assert!(pull.is_draft); // draft 是字段（GitLab 则是标题前缀——trait 推论 3）
        assert_eq!(pull.head_ref.as_deref(), Some("feat/dark"));
        assert_eq!(pull.base_ref.as_deref(), Some("main"));
        assert_eq!(pull.comments, 3);
    }

    #[test]
    fn maps_merged_state() {
        let mut v: Value = serde_json::from_str(PR_SAMPLE).unwrap();
        v["merged"] = Value::Bool(true);
        v["state"] = Value::String("closed".into());
        assert_eq!(map_gitea_pull(&v).state, "MERGED");
    }

    #[test]
    fn maps_minimal_comment() {
        let v: Value = serde_json::from_str(r#"{"user": {"login": "eve"}, "body": "hi"}"#).unwrap();
        let c = map_gitea_comment(&v);
        assert_eq!(c.author.as_deref(), Some("eve"));
        assert_eq!(c.body.as_deref(), Some("hi"));
        assert!(!c.pending);
    }
}
