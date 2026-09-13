//! Source 抽象——多来源的唯一分界线。
//!
//! trait 签名全枚举化（平台词汇不入签名，见知识库《架构设计-Source抽象与多来源》
//! Q2 的三处学费）：gh 子命令方言、合并旗标、状态大小写都关进各自实现。
//! `source_for` 是全项目唯一知道"这是谁"的地方。
//!
//! 概念对齐：trait ≈ 抽象基类，`impl Source for GhSource` ≈ 派生类，
//! `Box<dyn Source>` ≈ 多态指针。传输与认证属实现细节（gh = 子进程 + CLI 认证；
//! Gitea = reqwest + token），不进 trait 签名。

use std::path::PathBuf;

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

/// 仓库引用：来源解析的产物。owner/repo 是 API 口径；workdir 仅在
/// 存在本地克隆时有值（gh 子进程容错用），仅远端登记为 None。
#[derive(Debug, Clone)]
pub struct RepoRef {
    pub owner: String,
    pub repo: String,
    pub host: String,
    /// 来源连接的 platform（用户显式选择，路由依据）；无连接 = None（按 host 推断）。
    pub platform: Option<String>,
    pub workdir: Option<PathBuf>,
}

/// 数据来源抽象。
pub trait Source: Send + Sync {
    fn fetch_issues(&self, repo: &RepoRef, state: IssueStateFilter, limit: u32) -> Result<Vec<Issue>>;
    fn fetch_pulls(&self, repo: &RepoRef, state: PullStateFilter, limit: u32) -> Result<Vec<Pull>>;
    fn fetch_pull_detail(&self, repo: &RepoRef, number: i64) -> Result<Pull>;
    fn fetch_comments(&self, repo: &RepoRef, kind: Kind, number: i64) -> Result<Vec<Comment>>;
    fn add_comment(&self, repo: &RepoRef, kind: Kind, number: i64, body: &str) -> Result<Vec<Comment>>;
    fn set_issue_state(&self, repo: &RepoRef, number: i64, closed: bool) -> Result<Issue>;
    fn set_pull_state(&self, repo: &RepoRef, number: i64, closed: bool) -> Result<Pull>;
    fn merge_pull(&self, repo: &RepoRef, number: i64, method: MergeMethod) -> Result<Pull>;
}

/// 解析 target（前端传入的仓库标识 = 本地路径 或 仅远端 remote_url）：
/// 1. 登记表按 path 精确命中 → 用登记的 remote_url/host（快照）；
/// 2. 登记表按 remote_url 命中 → 仅远端登记，workdir = None；
/// 3. 都未命中 → 视为磁盘本地路径，现读 origin（git2 面板等仍传路径）。
pub fn resolve_target(target: &str) -> Result<RepoRef> {
    if let Some((remote_url, workdir, platform)) = crate::appdb::repo_find_by_target(target) {
        let mut r = ref_from_url(&remote_url, workdir)?;
        r.platform = platform;
        return Ok(r);
    }
    ref_from_local(target)
}

/// 登记表/磁盘之外的第三条路：直接从 URL 构造（登记时即时预览用）。
pub fn ref_from_url(url: &str, workdir: Option<std::path::PathBuf>) -> Result<RepoRef> {
    let (host, slug_path) = split_host_slug(url)
        .ok_or_else(|| anyhow!("无法从 remote 解析 host 与 owner/repo: {url}"))?;
    let mut parts = slug_path.split('/');
    let owner = parts.next().unwrap_or_default().to_string();
    let repo = parts.next().unwrap_or_default().to_string();
    if owner.is_empty() || repo.is_empty() {
        return Err(anyhow!("无法从 remote 解析 owner/repo: {url}"));
    }
    Ok(RepoRef { owner, repo, host, platform: None, workdir })
}

/// 本地路径：现读 origin（git 命令），与旧口径一致。
fn ref_from_local(path: &str) -> Result<RepoRef> {
    let url = crate::gh::git_origin(std::path::Path::new(path))
        .ok_or_else(|| anyhow!("未找到 origin remote: {path}"))?;
    ref_from_url(&url, Some(std::path::PathBuf::from(path)))
}

/// URL → (host, owner/repo 路径)。URL 带端口时 host 保留端口（自建实例常见）。
pub fn split_host_slug(url: &str) -> Option<(String, String)> {
    let s = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let s = s.split_once('@').map(|(_, rest)| rest).unwrap_or(s);
    // scp 形态（host:owner/repo）：冒号在首个斜杠前，且冒号后不是纯数字端口
    // （host:3000/o/r 是带端口的 URL，仍走 URL 分支）。
    if let Some(colon) = s.find(':') {
        if s.find('/').map_or(true, |slash| colon < slash) {
            let after_colon = &s[colon + 1..];
            let port_like = after_colon
                .split('/')
                .next()
                .map_or(false, |p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
            if !port_like {
                return Some((
                    s[..colon].to_lowercase(),
                    after_colon.trim_end_matches(".git").to_string(),
                ));
            }
        }
    }
    // URL 形态：host(/port)/owner/repo
    let (host, slug) = s.split_once('/')?;
    Some((
        host.to_lowercase(),
        slug.trim_end_matches('/').trim_end_matches(".git").to_string(),
    ))
}

/// 全项目唯一的来源实现选择：**按连接的 platform 路由**（用户添加连接时
/// 显式选择 = user_set 最高优先级）；无连接时按 host 推断兜底（auto）。
/// Gitea 与 Gitee（v1/v5 皆仿 GitHub）共用同一兼容实现，仅 API 前缀与
/// 合并方言不同。GitHub 透传 gh 活动账户；gitlab/unknown 后续实现。
pub fn source_for_ref(platform: Option<&str>, host: &str) -> Box<dyn Source> {
    let kind = platform
        .map(str::to_string)
        .unwrap_or_else(|| crate::appdb::platform_for_host(host).unwrap_or_else(|| "github".into()));
    match kind.as_str() {
        "gitea" | "gitee" => {
            let token = keyring_token(&kind);
            Box::new(crate::gitea::GiteaSource::new(kind, host.to_string(), token))
        }
        _ => Box::new(crate::gh::GhSource),
    }
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
    fn split_host_slug_parses_https_scp_and_self_hosted() {
        assert_eq!(
            split_host_slug("https://github.com/o/r.git"),
            Some(("github.com".into(), "o/r".into()))
        );
        // scp 语法：git@host:owner/repo
        assert_eq!(
            split_host_slug("git@github.com:o/r.git"),
            Some(("github.com".into(), "o/r".into()))
        );
        // URL 带端口：host 保留端口，不得误判为 scp
        assert_eq!(
            split_host_slug("https://gitea.example.com:3000/o/r.git"),
            Some(("gitea.example.com:3000".into(), "o/r".into()))
        );
        // 自建 host 原样返回（未来交 API 指纹探测 / 设置兜底）
        assert_eq!(
            split_host_slug("https://git.company.com/team/r.git"),
            Some(("git.company.com".into(), "team/r".into()))
        );
    }

    #[test]
    fn state_filters_parse() {
        assert_eq!(IssueStateFilter::parse("all").unwrap(), IssueStateFilter::All);
        assert_eq!(PullStateFilter::parse("merged").unwrap(), PullStateFilter::Merged);
        assert!(IssueStateFilter::parse("merged").is_err());
        assert!(PullStateFilter::parse("opened").is_err()); // GitLab 方言不得回流
    }
}
