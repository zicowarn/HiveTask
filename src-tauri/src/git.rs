//! Local git repository reader (git2/libgit2): commit history, branch list
//! with ahead/behind, plus a fetch that shells out to `git` so the user's
//! credential helpers keep working. Read-only over libgit2 — no index or
//! worktree mutation.

use anyhow::{anyhow, Context, Result};

use crate::models::{BranchRow, CommitRow, GitRefRow, GitHistoryPage};

const HISTORY_LIMIT_DEFAULT: usize = 500;

fn open_repo(repo_path: &str) -> Result<git2::Repository> {
    git2::Repository::open(repo_path).context("打开 Git 仓库失败")
}

/// Commit history across every local + remote tip (the graph view walks all
/// of them), newest first. `limit` clamps the page; the renderer drives
/// paging later if needed.
pub fn history(repo_path: &str, limit: Option<u32>) -> Result<GitHistoryPage> {
    let repo = open_repo(repo_path)?;
    if repo.is_empty()? {
        return Ok(GitHistoryPage { commits: vec![], refs: vec![], head: None, has_more: false });
    }

    let limit = limit
        .map(|n| n.clamp(10, 2000) as usize)
        .unwrap_or(HISTORY_LIMIT_DEFAULT);

    // Decorations: local branch → "head" (current one → "current"), remote
    // tracking → "remote". Names use git's shorthand ("main", "origin/dev").
    let head_short = head_branch_name(&repo)?;
    let mut refs = Vec::new();
    let mut glob_starts: Vec<git2::Oid> = Vec::new();
    let references = repo.references()?;
    for r in references.flatten() {
        let name = match r.name() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if !name.starts_with("refs/heads/") && !name.starts_with("refs/remotes/") {
            continue;
        }
        // origin/HEAD is a pointer, not a branch — skip it.
        if name.ends_with("/HEAD") {
            continue;
        }
        let Some(target) = r.target() else { continue };
        let shorthand = r.shorthand().unwrap_or_default().to_string();
        if shorthand.is_empty() {
            continue;
        }
        let kind = if name.starts_with("refs/heads/") {
            if Some(shorthand.as_str()) == head_short.as_deref() {
                "current"
            } else {
                "head"
            }
        } else {
            "remote"
        };
        glob_starts.push(target);
        refs.push(GitRefRow { name: shorthand, target: target.to_string(), kind: kind.to_string() });
    }

    let mut revwalk = repo.revwalk()?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    for oid in &glob_starts {
        revwalk.push(*oid)?;
    }

    let mut commits = Vec::with_capacity(limit);
    for oid in revwalk.take(limit) {
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let parents =
            (0..commit.parent_count()).filter_map(|i| commit.parent_id(i).ok()).map(|p| p.to_string()).collect();
        let author = commit.author().name().ok().map(str::to_string);
        commits.push(CommitRow {
            oid: oid.to_string(),
            parents,
            message: commit.summary().ok().unwrap_or_default().unwrap_or_default().to_string(),
            author,
            committed_at_unix: commit.time().seconds(),
        });
    }

    Ok(GitHistoryPage { commits, refs, head: head_short, has_more: false })
}

fn head_branch_name(repo: &git2::Repository) -> Result<Option<String>> {
    if repo.head_detached()? {
        return Ok(None);
    }
    match repo.head() {
        Ok(head) => Ok(head.shorthand().ok().map(str::to_string)),
        // Unborn HEAD (branch name but zero commits) — treat like empty.
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// All branches — locals with tracking ahead/behind, then remotes. The UI
/// renders one strip with two visual groups.
pub fn branches(repo_path: &str) -> Result<Vec<BranchRow>> {
    let repo = open_repo(repo_path)?;
    if repo.is_empty()? {
        return Ok(vec![]);
    }

    let mut rows = Vec::new();
    for (branch, _) in repo.branches(Some(git2::BranchType::Local))?.flatten() {
        let Some(name) = branch.name()?.map(str::to_string) else { continue };
        let reference = branch.get();
        let Some(oid) = reference.target() else { continue };
        let (ahead, behind) = match branch.upstream() {
            Ok(upstream) => upstream
                .get()
                .target()
                .map(|up| repo.graph_ahead_behind(oid, up))
                .transpose()?
                .unwrap_or((0, 0)),
            Err(_) => (0, 0),
        };
        rows.push(BranchRow {
            name,
            is_remote: false,
            is_current: branch.is_head(),
            short_id: Some(oid.to_string()[..7].to_string()),
            ahead: ahead as i64,
            behind: behind as i64,
        });
    }
    for (branch, _) in repo.branches(Some(git2::BranchType::Remote))?.flatten() {
        let Some(name) = branch.name()?.map(str::to_string) else { continue };
        if name.ends_with("/HEAD") {
            continue;
        }
        let oid = branch.get().target();
        rows.push(BranchRow {
            name,
            is_remote: true,
            is_current: false,
            short_id: oid.map(|o| o.to_string()[..7].to_string()),
            ahead: 0,
            behind: 0,
        });
    }
    Ok(rows)
}

/// `git fetch --all` via the git binary (libgit2 fetch would need credential
/// callbacks; the CLI reuses the user's helpers). GIT_TERMINAL_PROMPT=0
/// fails fast instead of hanging the GUI on a hidden credential prompt.
pub fn fetch(repo_path: &str) -> Result<()> {
    let output = std::process::Command::new("git")
        .args(["fetch", "--all", "--quiet"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(repo_path)
        .output()
        .context("启动 git 失败")?;
    if output.status.success() {
        return Ok(());
    }
    Err(anyhow!("{}", String::from_utf8_lossy(&output.stderr).trim()))
}

#[cfg(test)]
mod git_tests {
    use super::*;

    #[test]
    fn history_reads_real_clone() {
        // The durable demo clone; skip if absent (CI).
        let path = "/Users/mrwang/.hivetask-demos/tauri-real";
        if !std::path::Path::new(path).exists() {
            return;
        }
        let page = history(path, Some(100)).unwrap();
        assert_eq!(page.commits.len(), 100);
        assert!(page.refs.iter().any(|r| r.kind == "current"));
        let first = &page.commits[0];
        assert!(!first.oid.is_empty());
        assert!(!first.message.is_empty());
    }

    #[test]
    fn history_on_unborn_repo_returns_empty_page() {
        // git init + zero commits: repo.head() is UnbornBranch, which used
        // to bubble up as an error instead of an empty graph.
        let dir = std::env::temp_dir().join(format!(
            "hivetask-unborn-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        git2::Repository::init(&dir).unwrap();
        let page = history(dir.to_str().unwrap(), Some(50)).unwrap();
        assert!(page.commits.is_empty());
        assert!(page.refs.is_empty());
        assert_eq!(page.head, None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
