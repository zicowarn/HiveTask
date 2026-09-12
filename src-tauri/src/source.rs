//! Source 抽象——多来源的唯一分界线。
//!
//! trait 签名全枚举化（平台词汇不入签名，见知识库《架构设计-Source抽象与多来源》
//! Q2 的三处学费）：gh 子命令方言、合并旗标、状态大小写都关进各自实现。
//! `source_for` 是全项目唯一知道"这是谁"的地方。
//!
//! 概念对齐：trait ≈ 抽象基类，`impl Source for GhSource` ≈ 派生类，
//! `Box<dyn Source>` ≈ 多态指针。传输与认证属实现细节（gh = 子进程 + CLI 认证；
//! Gitea = reqwest + token），不进 trait 签名。

use std::path::Path;

use anyhow::{anyhow, Result};

use crate::models::{Comment, Issue, Pull};

/// 会话实体类型。gh 的子命令是 `pr` 不是 `pull`（235b374 的学费）——
/// 该翻译属 GhSource 内部，本枚举是跨平台口径（storage 同此口径）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Issue,
    Pull,
}

impl Kind {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "issue" => Ok(Self::Issue),
            "pull" => Ok(Self::Pull),
            other => Err(anyhow!("未知的实体类型: {other}")),
        }
    }

    /// storage 层与前端约定的口径字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Issue => "issue",
            Self::Pull => "pull",
        }
    }
}

/// 合并方式。`--merge/--squash/--rebase` 是 gh 旗标（--admin 注入防护的
/// 白名单测试即此），Gitea 是 `?squash=true`——各实现自行映射。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "merge" => Ok(Self::Merge),
            "squash" => Ok(Self::Squash),
            "rebase" => Ok(Self::Rebase),
            other => Err(anyhow!("未知的合并方式: {other}")),
        }
    }
}

/// Issue 列表过滤器（前端 "open" | "closed" | "all"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueStateFilter {
    Open,
    Closed,
    All,
}

impl IssueStateFilter {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "open" => Ok(Self::Open),
            "closed" => Ok(Self::Closed),
            "all" => Ok(Self::All),
            other => Err(anyhow!("未知的 issue 过滤器: {other}")),
        }
    }
}

/// PR 列表过滤器（前端 "open" | "closed" | "merged" | "all"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullStateFilter {
    Open,
    Closed,
    Merged,
    All,
}

impl PullStateFilter {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "open" => Ok(Self::Open),
            "closed" => Ok(Self::Closed),
            "merged" => Ok(Self::Merged),
            "all" => Ok(Self::All),
            other => Err(anyhow!("未知的 pull 过滤器: {other}")),
        }
    }
}

/// 数据来源抽象。`repo` 是本地仓库路径（来源按其 remote 解析）。
pub trait Source: Send + Sync {
    fn fetch_issues(&self, repo: &Path, state: IssueStateFilter, limit: u32) -> Result<Vec<Issue>>;
    fn fetch_pulls(&self, repo: &Path, state: PullStateFilter, limit: u32) -> Result<Vec<Pull>>;
    fn fetch_pull_detail(&self, repo: &Path, number: i64) -> Result<Pull>;
    fn fetch_comments(&self, repo: &Path, kind: Kind, number: i64) -> Result<Vec<Comment>>;
    fn add_comment(&self, repo: &Path, kind: Kind, number: i64, body: &str) -> Result<Vec<Comment>>;
    fn set_issue_state(&self, repo: &Path, number: i64, closed: bool) -> Result<Issue>;
    fn set_pull_state(&self, repo: &Path, number: i64, closed: bool) -> Result<Pull>;
    fn merge_pull(&self, repo: &Path, number: i64, method: MergeMethod) -> Result<Pull>;
}

/// 读 origin remote 的 host（https 与 scp 语法都覆盖），
/// 如 "github.com"。无 remote / 无法解析 → None。
pub fn remote_host(repo: &Path) -> Option<String> {
    let url = crate::gh::git_origin(repo)?;
    let s = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(&url);
    let s = s.split_once('@').map(|(_, rest)| rest).unwrap_or(s);
    let host = s.split('/').next()?.split(':').next()?;
    (!host.is_empty()).then(|| host.to_lowercase())
}

/// 全项目唯一的来源解析点：读 git remote，按 host 选实现。
/// 解析顺序：GitHub（域名匹配）→ 已配置的 Gitea host（精确匹配配置值，
/// 自建 host 任意）→ 其余暂回落 GitHub（未来交 API 指纹探测 / 设置兜底，
/// 见设计文档 Q4 推论 1）。token 属 GiteaSource 构造细节，从钥匙串取。
pub fn source_for(repo: &Path) -> Result<Box<dyn Source>> {
    let Some(host) = remote_host(repo) else {
        return Ok(Box::new(crate::gh::GhSource));
    };
    if host.contains("github") {
        return Ok(Box::new(crate::gh::GhSource));
    }
    let config = crate::source_config::load();
    if let Some(gitea_host) = config.gitea_host.filter(|h| !h.trim().is_empty()) {
        let configured = gitea_host
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .trim_end_matches('/')
            .to_lowercase();
        if host == configured {
            let token = keyring_token("gitea");
            return Ok(Box::new(crate::gitea::GiteaSource::new(gitea_host, token)));
        }
    }
    Ok(Box::new(crate::gh::GhSource))
}

fn keyring_token(platform: &str) -> Option<String> {
    let entry = keyring::Entry::new(&format!("hivetask.{platform}"), "token").ok()?;
    entry.get_password().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_parse_and_str() {
        assert_eq!(Kind::parse("issue").unwrap(), Kind::Issue);
        assert_eq!(Kind::parse("pull").unwrap(), Kind::Pull);
        assert!(Kind::parse("pr").is_err()); // gh 方言不得回流
        assert!(Kind::parse("--admin").is_err());
        assert_eq!(Kind::Issue.as_str(), "issue");
    }

    #[test]
    fn merge_method_parse_rejects_injection() {
        assert_eq!(MergeMethod::parse("squash").unwrap(), MergeMethod::Squash);
        assert!(MergeMethod::parse("--admin").is_err());
        assert!(MergeMethod::parse("").is_err());
    }

    #[test]
    fn remote_host_parses_https_and_scp() {
        let dir = std::env::temp_dir().join(format!(
            "hivetask-host-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let repo = git2::Repository::init(&dir).unwrap();
        repo.remote("origin", "https://github.com/o/r.git").unwrap();
        assert_eq!(remote_host(&dir).as_deref(), Some("github.com"));
        repo.remote_set_url("origin", "git@github.com:o/r.git").unwrap();
        assert_eq!(remote_host(&dir).as_deref(), Some("github.com"));
        // 自建 host 原样返回（未来交 API 指纹探测 / 设置兜底）
        repo.remote_set_url("origin", "https://git.company.com/team/r.git").unwrap();
        assert_eq!(remote_host(&dir).as_deref(), Some("git.company.com"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn state_filters_parse() {
        assert_eq!(IssueStateFilter::parse("all").unwrap(), IssueStateFilter::All);
        assert_eq!(PullStateFilter::parse("merged").unwrap(), PullStateFilter::Merged);
        assert!(IssueStateFilter::parse("merged").is_err());
        assert!(PullStateFilter::parse("opened").is_err()); // GitLab 方言不得回流
    }
}
