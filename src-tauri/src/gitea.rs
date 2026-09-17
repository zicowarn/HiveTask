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
        // host 归一为完整基址：路由传入的 RepoRef.host 来自 split_host_slug，
        // scheme 已被剥掉（"gitee.com"），直接拼接会得到相对 URL 而请求必败
        // （实测 "Gitea 请求失败"）；此处统一补 https://。
        // 注意：http-only 自建实例需在路由侧透传连接 host（带 scheme），
        // 属后续项——当前路径下它本就不可用，补 https 不造成回退。
        let trimmed = host.trim_end_matches('/');
        let host = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            trimmed.to_string()
        } else {
            format!("https://{trimmed}")
        };
        Self { platform, host, token }
    }

    /// API 前缀：Gitea /api/v1，Gitee /api/v5。
    fn api_prefix(&self) -> &'static str {
        match self.platform.as_str() {
            "gitee" => "/api/v5",
            _ => "/api/v1",
        }
    }

    pub(crate) fn api(&self, path: &str) -> String {
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

    pub(crate) fn get(&self, url: &str) -> Result<Value> {
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

/// 线上仓库清单条目映射（`/user/repos`：Gitea v1 与 Gitee v5 字段同形）。
pub(crate) fn map_remote_repo(v: &Value) -> crate::source::RemoteRepoInfo {
    crate::source::RemoteRepoInfo {
        full_name: v.get("full_name").and_then(Value::as_str).unwrap_or_default().to_string(),
        url: v
            .get("clone_url")
            .and_then(Value::as_str)
            .or_else(|| v.get("html_url").and_then(Value::as_str))
            .unwrap_or_default()
            .to_string(),
        description: v.get("description").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string),
        updated_at: v.get("updated_at").and_then(Value::as_str).map(str::to_string),
    }
}

/// 该接入凭据下的线上仓库清单（「刷新从线上查找」的 Gitea/Gitee 实现）。
pub fn list_user_repos(platform: &str, host: &str, token: Option<String>) -> Result<Vec<crate::source::RemoteRepoInfo>> {
    let source = GiteaSource::new(platform.to_string(), host.to_string(), token);
    // limit/per_page 并写：Gitea 认 limit，Gitee v5 认 per_page
    let url = source.api("/user/repos?limit=100&per_page=100");
    let value = source.get(&url)?;
    Ok(value
        .as_array()
        .map(|arr| arr.iter().map(map_remote_repo).collect())
        .unwrap_or_default())
}

impl GiteaSource {
    fn comments_url(&self, slug: &RepoSlug, number: &str) -> String {
        self.api(&format!("/repos/{}/{}/issues/{number}/comments", slug.owner, slug.repo))
    }
    /// 写后 GET issues/{n} 回读全量（labels/assignees 端点返回的是子资源清单）。
    fn fetch_issue(&self, repo: &RepoRef, number: &str) -> Result<Issue> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/issues/{number}", slug.owner, slug.repo));
        let value = self.get(&url)?;
        Ok(map_gitea_issue(&value))
    }
}

impl Source for GiteaSource {
    fn repo_visibility(&self, repo: &RepoRef) -> Result<&'static str> {
        let slug = self.slug_ref(repo);
        let value = self.get(&self.api(&format!("/repos/{}/{}", slug.owner, slug.repo)))?;
        Ok(if value["private"].as_bool().unwrap_or(false) {
            "private"
        } else {
            "public"
        })
    }

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

    fn set_issue_state(&self, repo: &RepoRef, number: &str, closed: bool, _reason: Option<&str>) -> Result<Issue> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/issues/{number}", slug.owner, slug.repo));
        let state = if closed { "closed" } else { "open" };
        let value =
            self.send_json(reqwest::Method::PATCH, &url, serde_json::json!({ "state": state }))?;
        Ok(map_gitea_issue(&value))
    }

    fn set_issue_locked(&self, repo: &RepoRef, number: &str, locked: bool) -> Result<()> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/issues/{number}/lock", slug.owner, slug.repo));
        self.send_json(reqwest::Method::PUT, &url, serde_json::json!({ "locked": locked }))?;
        Ok(())
    }

    fn delete_issue(&self, _repo: &RepoRef, _number: &str) -> Result<()> {
        Err(anyhow!("Gitea/Gitee 没有删除 Issue 的 REST 通道"))
    }

    fn update_issue(&self, repo: &RepoRef, number: &str, title: &str, body: Option<&str>) -> Result<Issue> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/issues/{number}", slug.owner, slug.repo));
        // Gitea/Gitee 同构：PATCH issues/{n}，body 传空串即清空正文。
        let mut payload = serde_json::json!({ "title": title.trim() });
        if let Some(b) = body {
            payload["body"] = Value::from(b.trim());
        }
        let value = self.send_json(reqwest::Method::PATCH, &url, payload)?;
        Ok(map_gitea_issue(&value))
    }

    fn update_issue_milestone(&self, repo: &RepoRef, number: &str, milestone: Option<&str>) -> Result<Issue> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/issues/{number}", slug.owner, slug.repo));
        let payload = match milestone.map(str::trim).filter(|s| !s.is_empty()) {
            Some(name) => {
                let list_url = self.api(&format!("/repos/{}/{}/milestones?state=all&limit=100", slug.owner, slug.repo));
                let list = self.get(&list_url)?;
                let id = list
                    .as_array()
                    .and_then(|arr| {
                        arr.iter()
                            .find(|m| m.get("title").and_then(Value::as_str).map(|t| t.eq_ignore_ascii_case(name)).unwrap_or(false))
                            .and_then(|m| m.get("id"))
                    })
                    .and_then(Value::as_i64);
                match id {
                    Some(mid) => serde_json::json!({ "milestone": mid }),
                    None => return Err(anyhow!("里程碑不存在: {name}")),
                }
            }
            None => serde_json::json!({ "milestone": 0 }),
        };
        self.send_json(reqwest::Method::PATCH, &url, payload)?;
        self.fetch_issue(repo, number)
    }

    fn update_issue_labels(&self, repo: &RepoRef, number: &str, labels: &[String]) -> Result<Issue> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/issues/{number}/labels", slug.owner, slug.repo));
        // 名字 → id（Gitea/Gitee 同为 id 数组整体替换）
        let all = self.list_labels(repo)?;
        let ids: Vec<Value> = all
            .iter()
            .filter(|l| labels.iter().any(|n| n.eq_ignore_ascii_case(&l.name)))
            .map(|l| Value::from(l.id))
            .collect();
        self.send_json(reqwest::Method::PUT, &url, serde_json::json!({ "labels": ids }))?;
        self.fetch_issue(repo, number)
    }

    fn update_issue_assignees(&self, repo: &RepoRef, number: &str, assignees: &[String]) -> Result<Issue> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/issues/{number}/assignees", slug.owner, slug.repo));
        let names: Vec<&str> = assignees.iter().map(String::as_str).collect();
        self.send_json(reqwest::Method::PUT, &url, serde_json::json!({ "assignees": names }))?;
        self.fetch_issue(repo, number)
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

    fn create_issue(&self, repo: &RepoRef, title: &str, body: Option<&str>, milestone: Option<&str>, labels: &[String], assignees: &[String]) -> Result<Issue> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/issues", slug.owner, slug.repo));
        // 里程碑按名归属：REST 需要 id，先从里程碑清单按标题解析
        let mut payload = serde_json::json!({ "title": title, "body": body });
        if let Some(name) = milestone {
            let list_url = self.api(&format!("/repos/{}/{}/milestones?limit=100", slug.owner, slug.repo));
            let list = self.get(&list_url)?;
            let id = list
                .as_array()
                .and_then(|arr| {
                    arr.iter()
                        .find(|m| m.get("title").and_then(Value::as_str).map(|t| t.eq_ignore_ascii_case(name)).unwrap_or(false))
                        .and_then(|m| m.get("id"))
                })
                .and_then(Value::as_i64);
            match id {
                Some(mid) => payload["milestone_id"] = Value::from(mid),
                None => return Err(anyhow!("里程碑不存在: {name}")),
            }
        }
        // Gitea REST：labels 传 id 数组（名字 → id 就地解析），assignees 传登录名
        if !labels.is_empty() {
            let all = self.list_labels(repo)?;
            let ids: Vec<Value> = all
                .iter()
                .filter(|l| labels.iter().any(|n| n.eq_ignore_ascii_case(&l.name)))
                .map(|l| Value::from(l.id))
                .collect();
            payload["labels"] = Value::from(ids);
        }
        if !assignees.is_empty() {
            payload["assignees"] = serde_json::to_value(assignees).context("序列化负责人失败")?;
        }
        let value = self.send_json(reqwest::Method::POST, &url, payload)?;
        Ok(map_gitea_issue(&value))
    }

    fn list_labels(&self, repo: &RepoRef) -> Result<Vec<crate::models::LabelInfo>> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/labels?limit=100", slug.owner, slug.repo));
        let value = self.get(&url)?;
        Ok(value
            .as_array()
            .map(|arr| {
                arr.iter()
                    .map(|v| crate::models::LabelInfo {
                        id: v.get("id").and_then(Value::as_i64).unwrap_or(0),
                        name: v.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                        color: v.get("color").and_then(Value::as_str).map(str::to_string),
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    fn list_assignees(&self, repo: &RepoRef) -> Result<Vec<String>> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/assignees?limit=100", slug.owner, slug.repo));
        let value = self.get(&url)?;
        Ok(value
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|u| u.get("login").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    }

    fn create_label(&self, repo: &RepoRef, name: &str, color: &str) -> Result<crate::models::LabelInfo> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/labels", slug.owner, slug.repo));
        // Gitea 色值形态带 # 前缀
        let color = if color.trim_start_matches('#').len() > 0 {
            format!("#{}", color.trim_start_matches('#'))
        } else {
            color.to_string()
        };
        let value = self.send_json(
            reqwest::Method::POST,
            &url,
            serde_json::json!({ "name": name.trim(), "color": color }),
        )?;
        Ok(crate::models::LabelInfo {
            id: value.get("id").and_then(Value::as_i64).unwrap_or(0),
            name: value.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
            color: value.get("color").and_then(Value::as_str).map(str::to_string),
        })
    }

    fn create_milestone(&self, repo: &RepoRef, title: &str, due_on: Option<&str>, description: Option<&str>) -> Result<String> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/milestones", slug.owner, slug.repo));
        let mut payload = serde_json::json!({ "title": title, "description": description });
        if let Some(d) = due_on {
            payload["due_on"] = Value::from(crate::gh::normalize_due_date(d));
        }
        let value = self.send_json(reqwest::Method::POST, &url, payload)?;
        Ok(value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(title)
            .to_string())
    }

    fn create_pull(&self, repo: &RepoRef, head: &str, base: &str, title: &str, body: Option<&str>) -> Result<Pull> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/pulls", slug.owner, slug.repo));
        let value = self.send_json(
            reqwest::Method::POST,
            &url,
            serde_json::json!({ "head": head, "base": base, "title": title, "body": body }),
        )?;
        Ok(map_gitea_pull(&value))
    }

    fn remote_branches(&self, repo: &RepoRef) -> Result<Vec<String>> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/branches?limit=100", slug.owner, slug.repo));
        let value = self.get(&url)?;
        Ok(value
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| b.get("name").and_then(Value::as_str).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    }

    fn list_milestones(&self, repo: &RepoRef) -> Result<Vec<crate::models::MilestoneInfo>> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!(
            "/repos/{}/{}/milestones?state=all&limit=100",
            slug.owner, slug.repo
        ));
        let value = self.get(&url)?;
        Ok(value
            .as_array()
            .map(|arr| arr.iter().map(parse_milestone_value).collect())
            .unwrap_or_default())
    }

    fn set_milestone_state(&self, repo: &RepoRef, number: i64, closed: bool) -> Result<crate::models::MilestoneInfo> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/milestones/{number}", slug.owner, slug.repo));
        let state = if closed { "closed" } else { "open" };
        let value =
            self.send_json(reqwest::Method::PATCH, &url, serde_json::json!({ "state": state }))?;
        Ok(parse_milestone_value(&value))
    }

    fn update_milestone(&self, repo: &RepoRef, number: i64, title: &str, description: Option<&str>, due_on: Option<&str>) -> Result<crate::models::MilestoneInfo> {
        let slug = self.slug_ref(repo);
        let url = self.api(&format!("/repos/{}/{}/milestones/{number}", slug.owner, slug.repo));
        let mut payload = serde_json::json!({ "title": title.trim() });
        if let Some(d) = description {
            payload["description"] = Value::from(d.trim());
        }
        if let Some(d) = due_on {
            payload["due_on"] = Value::from(crate::gh::normalize_due_date(d));
        }
        let value = self.send_json(reqwest::Method::PATCH, &url, payload)?;
        Ok(parse_milestone_value(&value))
    }
}

/// Gitea/Gitee 里程碑 REST JSON → MilestoneInfo（id 即编号；无 html_url）。
fn parse_milestone_value(v: &Value) -> crate::models::MilestoneInfo {
    crate::models::MilestoneInfo {
        number: v.get("id").and_then(Value::as_i64).unwrap_or(0),
        title: v.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
        description: v.get("description").and_then(Value::as_str).map(str::to_string),
        due_on: v.get("due_on").and_then(Value::as_str).map(str::to_string),
        state: v.get("state").and_then(Value::as_str).unwrap_or("open").to_string(),
        open_issues: v.get("open_issues").and_then(Value::as_i64).unwrap_or(0),
        closed_issues: v.get("closed_issues").and_then(Value::as_i64).unwrap_or(0),
        html_url: None,
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

    /// host 归一：裸域名补 https://；已带 scheme 原样保留。
    #[test]
    fn host_scheme_normalized() {
        let bare = GiteaSource::new("gitee".into(), "gitee.com".into(), None);
        assert_eq!(bare.api("/x"), "https://gitee.com/api/v5/x");
        let https = GiteaSource::new("gitea".into(), "https://gitea.lan/".into(), None);
        assert_eq!(https.api("/x"), "https://gitea.lan/api/v1/x");
        let http = GiteaSource::new("gitea".into(), "http://192.168.1.5:3000".into(), None);
        assert_eq!(http.api("/x"), "http://192.168.1.5:3000/api/v1/x");
    }

    #[test]
    fn maps_remote_repo_list_entry() {
        // Gitea v1 带 clone_url；Gitee v5 只有 html_url——都归一可用登记 URL
        let gitea: Value = serde_json::from_str(
            r#"{"full_name": "o/r", "clone_url": "https://gitea.lan/o/r.git",
                "html_url": "https://gitea.lan/o/r", "description": "d",
                "updated_at": "2026-09-01T00:00:00Z"}"#,
        )
        .unwrap();
        let m = map_remote_repo(&gitea);
        assert_eq!(m.full_name, "o/r");
        assert_eq!(m.url, "https://gitea.lan/o/r.git");
        let gitee: Value = serde_json::from_str(
            r#"{"full_name": "o/r2", "html_url": "https://gitee.com/o/r2"}"#,
        )
        .unwrap();
        assert_eq!(map_remote_repo(&gitee).url, "https://gitee.com/o/r2");
    }
}
