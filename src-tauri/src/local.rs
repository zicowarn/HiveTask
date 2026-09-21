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

    fn set_issue_state(&self, repo: &RepoRef, number: &str, closed: bool, _reason: Option<&str>) -> Result<Issue> {
        // 本地无关闭理由语义（journal v2 待办）
        let workdir = self.workdir(repo)?;
        let mut conn = storage::open(workdir)?;
        journal::sync(workdir, &mut conn)?;
        journal::set_issue_state(workdir, &mut conn, number, closed, &journal::current_author(workdir))
    }

    fn set_issue_locked(&self, _repo: &RepoRef, _number: &str, _locked: bool) -> Result<()> {
        Err(anyhow!("本地 Issue 暂不支持锁定讨论"))
    }

    fn delete_issue(&self, _repo: &RepoRef, _number: &str) -> Result<()> {
        // 事件日志不可变（真源），本地 Issue 不做删除
        Err(anyhow!("本地 Issue 按事件日志不可变，不支持删除"))
    }

    fn set_pull_state(&self, _repo: &RepoRef, _number: &str, _closed: bool) -> Result<Pull> {
        Err(anyhow!("本地仓库没有 Pull Request"))
    }

    fn merge_pull(&self, _repo: &RepoRef, _number: &str, _method: MergeMethod) -> Result<Pull> {
        Err(anyhow!("本地仓库没有 Pull Request"))
    }
    fn create_issue(&self, repo: &RepoRef, title: &str, body: Option<&str>, milestone: Option<&str>, _labels: &[String], _assignees: &[String]) -> Result<Issue> {
        // journal 事件 v1 无 labels/assignees 字段，本地创建忽略之
        let workdir = self.workdir(repo)?;
        let mut conn = crate::storage::open(workdir)?;
        journal::sync(workdir, &mut conn)?;
        journal::create_issue(workdir, &mut conn, title, body, &journal::current_author(workdir), milestone)
    }
    fn list_labels(&self, _repo: &RepoRef) -> Result<Vec<crate::models::LabelInfo>> {
        Ok(Vec::new()) // 本地无平台标签
    }
    fn list_assignees(&self, _repo: &RepoRef) -> Result<Vec<String>> {
        Ok(Vec::new()) // 本地无可指派用户
    }
    fn create_label(&self, _repo: &RepoRef, _name: &str, _color: &str) -> Result<crate::models::LabelInfo> {
        Err(anyhow!("本地仓库没有平台标签"))
    }
    fn update_issue(&self, repo: &RepoRef, number: &str, title: &str, body: Option<&str>) -> Result<Issue> {
        let workdir = self.workdir(repo)?;
        let mut conn = crate::storage::open(workdir)?;
        journal::sync(workdir, &mut conn)?;
        journal::edit_issue(workdir, &mut conn, number, title, body, &journal::current_author(workdir))
    }
    fn update_issue_milestone(&self, repo: &RepoRef, number: &str, milestone: Option<&str>) -> Result<Issue> {
        // 本地里程碑 = Issue 上的纯文本标签，无平台语义；写入走 journal 事件（真源）
        let workdir = self.workdir(repo)?;
        let mut conn = crate::storage::open(workdir)?;
        journal::sync(workdir, &mut conn)?;
        journal::set_issue_milestone(workdir, &mut conn, number, milestone, &journal::current_author(workdir))
    }
    fn update_issue_labels(&self, repo: &RepoRef, number: &str, labels: &[String]) -> Result<Issue> {
        let workdir = self.workdir(repo)?;
        let mut conn = crate::storage::open(workdir)?;
        journal::sync(workdir, &mut conn)?;
        journal::set_issue_labels(workdir, &mut conn, number, labels, &journal::current_author(workdir))
    }
    fn update_issue_assignees(&self, repo: &RepoRef, number: &str, assignees: &[String]) -> Result<Issue> {
        let workdir = self.workdir(repo)?;
        let mut conn = crate::storage::open(workdir)?;
        journal::sync(workdir, &mut conn)?;
        journal::set_issue_assignees(workdir, &mut conn, number, assignees, &journal::current_author(workdir))
    }
    fn create_milestone(&self, _repo: &RepoRef, _title: &str, _due_on: Option<&str>, _description: Option<&str>) -> Result<String> {
        Err(anyhow!("本地仓库没有平台里程碑"))
    }
    fn set_milestone_state(&self, _repo: &RepoRef, _number: i64, _closed: bool) -> Result<crate::models::MilestoneInfo> {
        Err(anyhow!("本地仓库没有平台里程碑"))
    }
    fn update_milestone(&self, _repo: &RepoRef, _number: i64, _title: &str, _description: Option<&str>, _due_on: Option<&str>) -> Result<crate::models::MilestoneInfo> {
        Err(anyhow!("本地仓库没有平台里程碑"))
    }
    fn create_pull(&self, _repo: &RepoRef, _head: &str, _base: &str, _title: &str, _body: Option<&str>) -> Result<Pull> {
        Err(anyhow!("本地仓库没有 Pull Request——分支即 PR，走本地分支 review"))
    }
    /// 本地 journal 事件模型无依赖/父子概念（《项目甘特图》§4.2 实证口径）
    /// → 恒空，前端诚实不显示。
    fn fetch_issue_relations(&self, _repo: &RepoRef, _number: &str) -> Result<crate::models::IssueRelations> {
        Ok(crate::models::IssueRelations::default())
    }
    fn list_milestones(&self, repo: &RepoRef) -> Result<Vec<crate::models::MilestoneInfo>> {
        // 本地里程碑 = Issue 上的纯文本标签（无截止/平台语义）
        let workdir = self.workdir(repo)?;
        let conn = crate::storage::open(workdir)?;
        let all = crate::storage::list_issues(&conn, "all")?;
        let mut seen: Vec<(String, i64, i64)> = Vec::new(); // (title, open, closed)
        for issue in &all {
            let Some(name) = issue.milestone.clone() else { continue };
            let entry = seen.iter_mut().find(|(t, _, _)| t == &name);
            let closed = (issue.state == "CLOSED") as i64;
            match entry {
                Some((_, open_n, closed_n)) => {
                    *open_n += 1 - closed;
                    *closed_n += closed;
                }
                None => seen.push((name, 1 - closed, closed)),
            }
        }
        Ok(seen
            .into_iter()
            .map(|(title, open_n, closed_n)| crate::models::MilestoneInfo {
                // 本地"里程碑"是 Issue 文本标签：无编号/描述/在线地址。
                number: 0,
                title,
                description: None,
                due_on: None,
                state: if open_n > 0 { "open".to_string() } else { "closed".to_string() },
                open_issues: open_n,
                closed_issues: closed_n,
                html_url: None,
            })
            .collect())
    }

    fn remote_branches(&self, repo: &RepoRef) -> Result<Vec<String>> {
        let workdir = self.workdir(repo)?;
        Ok(crate::git::branches(workdir.to_str().unwrap_or(""))
            .into_iter()
            .flat_map(|rows| rows.into_iter().filter(|b| !b.is_remote).map(|b| b.name))
            .collect())
    }
}
