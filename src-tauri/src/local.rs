//! 本地来源（`local`）——无 remote 仓库的 Issue 能力（P3 收官项）。
//!
//! 数据走 journal + SQLite 双落点（见 journal.rs）：读 = SQLite（读前先
//! sync 重放）；写 = journal append + 物化。PR 面板在本地仓库下是空集
//! （本地分支 review 属 P4，不在本次范围）。

use anyhow::{anyhow, Result};
use std::path::Path;

use crate::journal;
use crate::models::{Comment, Issue, Pull};
use crate::source::{
    IssueStateFilter, Kind, MergeMethod, PullStateFilter, RepoRef, Source,
};
use crate::storage;

pub struct LocalSource;

impl LocalSource {
    fn workdir<'a>(&self, repo: &'a RepoRef) -> Result<&'a Path> {
        repo.workdir
            .as_deref()
            .ok_or_else(|| anyhow!("本地仓库缺少工作目录"))
    }

    fn state(&self, filter: IssueStateFilter) -> &'static str {
        match filter {
            IssueStateFilter::Open => "open",
            IssueStateFilter::Closed => "closed",
            IssueStateFilter::All => "all",
        }
    }
}

impl Source for LocalSource {
    fn fetch_issues(&self, repo: &RepoRef, filter: IssueStateFilter, _limit: u32) -> Result<Vec<Issue>> {
        let workdir = self.workdir(repo)?;
        let mut conn = storage::open(workdir)?;
        journal::sync(workdir, &mut conn)?;
        storage::list_issues(&conn, self.state(filter))
    }

    fn fetch_pulls(&self, _repo: &RepoRef, _filter: PullStateFilter, _limit: u32) -> Result<Vec<Pull>> {
        // 本地仓库没有 PR；空集让 PR 工作区呈现自然空态。
        Ok(Vec::new())
    }

    fn fetch_pull_detail(&self, _repo: &RepoRef, _number: &str) -> Result<Pull> {
        Err(anyhow!("本地仓库没有 Pull Request"))
    }

    fn repo_visibility(&self, _repo: &RepoRef) -> Result<&'static str> {
        Err(anyhow!("本地仓库没有平台可见性"))
    }

    fn fetch_comments(&self, repo: &RepoRef, kind: Kind, number: &str) -> Result<Vec<Comment>> {
        if kind == Kind::Pull {
            return Ok(Vec::new());
        }
        let workdir = self.workdir(repo)?;
        let mut conn = storage::open(workdir)?;
        journal::sync(workdir, &mut conn)?;
        storage::list_comments(&conn, "issue", number)
    }

    fn add_comment(&self, repo: &RepoRef, kind: Kind, number: &str, body: &str) -> Result<Vec<Comment>> {
        if kind == Kind::Pull {
            return Err(anyhow!("本地仓库没有 Pull Request"));
        }
        let workdir = self.workdir(repo)?;
        let mut conn = storage::open(workdir)?;
        journal::sync(workdir, &mut conn)?;
        journal::add_comment(workdir, &mut conn, number, body, &journal::current_author(workdir))
    }

    fn set_issue_state(&self, repo: &RepoRef, number: &str, closed: bool) -> Result<Issue> {
        let workdir = self.workdir(repo)?;
        let mut conn = storage::open(workdir)?;
        journal::sync(workdir, &mut conn)?;
        journal::set_issue_state(workdir, &mut conn, number, closed, &journal::current_author(workdir))
    }

    fn set_pull_state(&self, _repo: &RepoRef, _number: &str, _closed: bool) -> Result<Pull> {
        Err(anyhow!("本地仓库没有 Pull Request"))
    }

    fn merge_pull(&self, _repo: &RepoRef, _number: &str, _method: MergeMethod) -> Result<Pull> {
        Err(anyhow!("本地仓库没有 Pull Request"))
    }
}
