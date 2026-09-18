//! Local git repository reader (git2/libgit2): commit history, branch list
//! with ahead/behind, plus a fetch that shells out to `git` so the user's
//! credential helpers keep working. Read-only over libgit2 — no index or
//! worktree mutation.

use anyhow::{anyhow, Context, Result};
use git2::Oid;

use crate::models::{BranchReviewDiff, BranchRow, CommitDayCount, CommitRow, GitRefRow, GitHistoryPage, ReviewBranch, ReviewFile};

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

/// **单文件**的历史：只保留"碰过这个文件"的提交。
///
/// 为什么需要单独一条命令（而不是给 `history` 加参数）：libgit2 没有 `git log -- <path>` 的直通 API，
/// 得自己走 **revwalk + 逐提交 diff + pathspec**：
///   1. 遍历提交（拓扑 + 时间序，与 `history` 同口径）；
///   2. 每个提交与它的**第一个父提交**做 diff，diff 时带 `pathspec(文件相对仓库根的路径)`；
///   3. diff 里有该文件的 delta → 这个提交碰过它，保留。
///
/// 代价是"每个提交一次 diff"，所以用 `limit` 兜住**扫描量**（扫到 limit 个提交就停），
/// 命中数单独可以再限（返回值里 `has_more` 表示是否因扫描上限而截断）。
pub fn file_history(repo_path: &str, file_rel: &str, limit: Option<u32>) -> Result<GitHistoryPage> {
    let repo = open_repo(repo_path)?;
    if repo.is_empty()? {
        return Ok(GitHistoryPage { commits: vec![], refs: vec![], head: None, has_more: false });
    }
    let scan_limit = limit.map(|n| n.clamp(10, 2000) as usize).unwrap_or(200);
    let head_short = head_branch_name(&repo)?;

    let mut revwalk = repo.revwalk()?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    revwalk.push_head()?;
    // 远端分支也纳入（与 history 的"所有 tip"口径一致）
    if let Ok(references) = repo.references() {
        for reference in references.flatten() {
            if reference.is_remote() {
                if let Ok(target) = reference.peel_to_commit() {
                    let _ = revwalk.push(target.id());
                }
            }
        }
    }

    let mut path_opts = git2::DiffOptions::new();
    path_opts.pathspec(file_rel);
    path_opts.include_typechange(true);

    let mut commits = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;
    for oid in revwalk {
        if scanned >= scan_limit {
            truncated = true;
            break;
        }
        scanned += 1;
        let oid = oid?;
        let commit = repo.find_commit(oid)?;
        let tree = commit.tree()?;
        let parent_tree = match commit.parent(0) {
            Ok(parent) => Some(parent.tree()?),
            Err(_) => None, // 根提交：与空树比
        };
        let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut path_opts))?;
        if diff.deltas().len() == 0 {
            continue; // 这个提交没碰该文件
        }
        let parents = (0..commit.parent_count())
            .filter_map(|i| commit.parent_id(i).ok())
            .map(|p| p.to_string())
            .collect();
        commits.push(CommitRow {
            oid: oid.to_string(),
            parents,
            message: commit.summary().ok().unwrap_or_default().unwrap_or_default().to_string(),
            author: commit.author().name().ok().map(str::to_string),
            committed_at_unix: commit.time().seconds(),
        });
    }

    Ok(GitHistoryPage {
        commits,
        refs: Vec::new(),
        head: head_short,
        has_more: truncated,
    })
}

/// 天数（自 1970-01-01 起，可为负）→ (年, 月, 日)。Howard Hinnant 的
/// civil_from_days 算法——不引 chrono，只为「提交按日分桶」这一个用途。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 每日提交计数（日历「提交热力」图层数据源）：HEAD + 全部本地分支的
/// 去重提交，按**提交者时区的本地日期**分桶，窗口 `days` 天（1..=366）。
/// 空仓库返回空表。远端跟踪引用不计——热力图语义 = 本地完成的工作
/// （含未推送，相对 GitHub 贡献图的差异点，README 口径）。
pub fn commit_activity(repo_path: &str, days: u32) -> Result<Vec<CommitDayCount>> {
    let repo = open_repo(repo_path)?;
    if repo.is_empty()? {
        return Ok(vec![]);
    }
    let window_days = days.clamp(1, 366) as i64;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .context("系统时钟早于 Unix 纪元")?
        .as_secs() as i64;
    let since = now - window_days * 86_400;

    // 去重起点：HEAD + 全部本地分支（远端跟踪不计）。
    let mut tips: Vec<Oid> = Vec::new();
    if let Some(oid) = repo.head().ok().and_then(|h| h.target()) {
        tips.push(oid);
    }
    for branch in repo.branches(Some(git2::BranchType::Local))? {
        let (branch, _) = branch?;
        if let Some(oid) = branch.get().target() {
            if !tips.contains(&oid) {
                tips.push(oid);
            }
        }
    }

    let mut seen: std::collections::HashSet<Oid> = Default::default();
    let mut buckets: std::collections::BTreeMap<String, u32> = Default::default();
    for tip in tips {
        let mut revwalk = repo.revwalk()?;
        revwalk.set_sorting(git2::Sort::TIME)?;
        revwalk.push(tip)?;
        for oid in revwalk {
            let oid = oid?;
            if !seen.insert(oid) {
                continue;
            }
            let commit = repo.find_commit(oid)?;
            let time = commit.time();
            if time.seconds() < since {
                // Sort::TIME 下时间单调向后，越过窗口即可停（本条 walk）。
                break;
            }
            let local_days =
                (time.seconds() + i64::from(time.offset_minutes()) * 60).div_euclid(86_400);
            let (y, m, d) = civil_from_days(local_days);
            *buckets.entry(format!("{y:04}-{m:02}-{d:02}")).or_insert(0) += 1;
        }
    }
    Ok(buckets
        .into_iter()
        .map(|(date, count)| CommitDayCount { date, count })
        .collect())
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

// ---- 本地分支 review（设计：《本地Issue与本地分支Review》Q3）----
// git2 只做预览与检测（diff/内存合并分析）；一切写操作走 shell git
//（fetch 先例：复用用户配置与 hooks）。红线：不做冲突解决 UI。

fn resolve_branch_oid(repo: &git2::Repository, name: &str) -> Result<Oid> {
    let reference = repo
        .find_reference(&format!("refs/heads/{name}"))
        .with_context(|| format!("分支不存在: {name}"))?;
    reference
        .target()
        .ok_or_else(|| anyhow!("分支未指向提交: {name}"))
}

/// PR 创建流程的 ref 解析：本地分支优先，origin/{name} 远程跟踪分支兜底
/// （head/base 来自远端分支清单，克隆里是 refs/remotes/origin/*）。
fn resolve_pr_oid(repo: &git2::Repository, name: &str) -> Result<Oid> {
    repo.find_reference(&format!("refs/heads/{name}"))
        .or_else(|_| repo.find_reference(&format!("refs/remotes/origin/{name}")))
        .with_context(|| format!("分支不存在（本地与 origin 均未找到，可先抓取远端）: {name}"))?
        .target()
        .ok_or_else(|| anyhow!("分支未指向提交: {name}"))
}

/// PR 创建预览：base..head 间提交清单（拓扑+时间序，新→旧，上限 200）。
pub fn commits_between(repo_path: &str, base: &str, head: &str) -> Result<Vec<CommitRow>> {
    let repo = open_repo(repo_path)?;
    let base_oid = resolve_pr_oid(&repo, base)?;
    let head_oid = resolve_pr_oid(&repo, head)?;
    let mut commits = Vec::new();
    let mut revwalk = repo.revwalk()?;
    revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
    revwalk.push(head_oid)?;
    if let Ok(ancestor) = repo.merge_base(base_oid, head_oid) {
        revwalk.hide(ancestor)?;
    }
    for oid in revwalk.take(200) {
        commits.push(commit_row(&repo, oid?)?);
    }
    Ok(commits)
}

fn commit_row(repo: &git2::Repository, oid: Oid) -> Result<CommitRow> {
    let commit = repo.find_commit(oid)?;
    let parents =
        (0..commit.parent_count()).filter_map(|i| commit.parent_id(i).ok()).map(|p| p.to_string()).collect();
    let message = commit.summary().ok().unwrap_or_default().unwrap_or_default().to_string();
    let author = commit.author().name().ok().map(str::to_string);
    let committed_at_unix = commit.time().seconds();
    Ok(CommitRow { oid: oid.to_string(), parents, message, author, committed_at_unix })
}

/// 待 review 分支清单：非 base 的本地分支，相对 base 的领先/落后计数，
/// 领先者在前。
pub fn review_branch_list(repo_path: &str, base: &str) -> Result<Vec<ReviewBranch>> {
    let repo = open_repo(repo_path)?;
    if repo.is_empty()? {
        return Ok(vec![]);
    }
    let base_oid = resolve_branch_oid(&repo, base)?;
    let head_short = head_branch_name(&repo)?;
    let mut rows = Vec::new();
    for (branch, _) in repo.branches(Some(git2::BranchType::Local))?.flatten() {
        let Some(name) = branch.name()?.map(str::to_string) else { continue };
        if name == base {
            continue;
        }
        let Some(oid) = branch.get().target() else { continue };
        let (ahead, behind) = repo.graph_ahead_behind(oid, base_oid)?;
        rows.push(ReviewBranch {
            name: name.clone(),
            is_current: head_short.as_deref() == Some(name.as_str()),
            ahead: ahead as i64,
            behind: behind as i64,
            short_id: oid.to_string()[..7].to_string(),
        });
    }
    rows.sort_by(|a, b| b.ahead.cmp(&a.ahead).then_with(|| a.name.cmp(&b.name)));
    Ok(rows)
}

/// 分支 review 预览：提交清单 + 逐文件 unified patch + 可合并性
/// （内存 merge_trees 检测冲突，不碰 index/工作区）。patch 总量超限截断。
pub fn review_diff(repo_path: &str, base: &str, head: &str) -> Result<BranchReviewDiff> {
    let repo = open_repo(repo_path)?;
    let base_oid = resolve_branch_oid(&repo, base)?;
    let head_oid = resolve_branch_oid(&repo, head)?;

    let ancestor = repo.merge_base(base_oid, head_oid).ok();
    let up_to_date = ancestor == Some(head_oid);

    // 提交清单：base..head（revwalk 隐藏 base 可达集）
    let mut commits = Vec::new();
    if !up_to_date {
        let mut revwalk = repo.revwalk()?;
        revwalk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)?;
        revwalk.push(head_oid)?;
        if let Some(a) = ancestor {
            revwalk.hide(a)?;
        }
        for oid in revwalk.take(200) {
            commits.push(commit_row(&repo, oid?)?);
        }
    }

    // 可合并性：三方内存合并（ancestor = merge_base），零工作区副作用
    let (conflict, mergeable) = if up_to_date {
        (false, false)
    } else {
        let ancestor_commit = repo.find_commit(ancestor.ok_or_else(|| anyhow!("无共同祖先，无法自动合并"))?)?;
        let ancestor_tree = ancestor_commit.tree()?;
        let our = repo.find_commit(base_oid)?;
        let our_tree = our.tree()?;
        let their = repo.find_commit(head_oid)?;
        let their_tree = their.tree()?;
        let mut opts = git2::MergeOptions::new();
        let index = repo.merge_trees(&ancestor_tree, &our_tree, &their_tree, Some(&mut opts))?;
        let conflict = index.has_conflicts();
        (conflict, !conflict)
    };

    // 文件 diff：merge_base 树 → head 树；ancestor 缺失（无共同祖先）退空树
    let mut files = Vec::new();
    let mut truncated = false;
    const PATCH_BUDGET: usize = 256 * 1024;
    let mut budget = PATCH_BUDGET;
    if !up_to_date {
        let head_commit = repo.find_commit(head_oid)?;
        let head_tree = head_commit.tree()?;
        let ancestor_tree = match ancestor {
            Some(a) => Some(repo.find_commit(a)?.tree()?),
            None => None,
        };
        let diff = repo.diff_tree_to_tree(
            ancestor_tree.as_ref(),
            Some(&head_tree),
            Some(git2::DiffOptions::new().context_lines(3)),
        )?;
        for (i, delta) in diff.deltas().enumerate() {
            let Some(new_path) = delta.new_file().path().or_else(|| delta.old_file().path()) else { continue };
            let status = match delta.status() {
                git2::Delta::Added => "added",
                git2::Delta::Deleted => "deleted",
                git2::Delta::Renamed => "renamed",
                _ => "modified",
            };
            let mut additions = 0i64;
            let mut deletions = 0i64;
            let mut patch = None;
            if let Ok(Some(mut p)) = git2::Patch::from_diff(&diff, i) {
                if let Ok((ins, del, _ctx)) = p.line_stats() {
                    additions = ins as i64;
                    deletions = del as i64;
                }
                let mut raw = String::new();
                if p.print(&mut |_delta, _hunk, line| {
                    raw.push_str(&String::from_utf8_lossy(line.content()));
                    true
                })
                .is_ok()
                {
                    if budget > 0 {
                        let cut = raw.len().min(budget);
                        let mut t = raw[..cut].to_string();
                        if cut < raw.len() {
                            t.push_str("\n…… patch 过长，已截断 ……");
                            truncated = true;
                        }
                        budget -= cut;
                        patch = Some(t);
                    } else {
                        truncated = true;
                    }
                }
            }
            files.push(ReviewFile {
                path: new_path.to_string_lossy().to_string(),
                status: status.to_string(),
                additions,
                deletions,
                patch,
            });
        }
    }

    Ok(BranchReviewDiff {
        base: base.to_string(),
        head: head.to_string(),
        up_to_date,
        mergeable,
        conflict,
        commits,
        files,
        truncated,
    })
}

/// 工作区是否干净（`git status --porcelain` 为空）。
fn worktree_clean(repo_path: &str) -> Result<bool> {
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(repo_path)
        .output()
        .context("启动 git 失败")?;
    if !output.status.success() {
        return Err(anyhow!("{}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(output.stdout.is_empty())
}

fn run_git(repo_path: &str, args: &[&str]) -> Result<String> {
    let output = std::process::Command::new("git")
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .current_dir(repo_path)
        .output()
        .context("启动 git 失败")?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    Err(anyhow!(
        "{}",
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    ))
}

/// 执行合并（merge / squash / rebase 三选，设计定案保留三职能）。
/// 前置：工作区必须干净；流程 = checkout base → 按方式合并；
/// rebase = head 上 rebase base 后回 base --ff-only。冲突/失败诚实报错
/// （红线：不提供解决 UI）。
pub fn review_merge(repo_path: &str, base: &str, head: &str, method: &str) -> Result<String> {
    if !worktree_clean(repo_path)? {
        return Err(anyhow!("工作区有未提交改动，请先提交或暂存后再合并"));
    }
    // 预检目标分支存在（给出可读错误而非 git 裸输出）
    {
        let repo = open_repo(repo_path)?;
        resolve_branch_oid(&repo, base)?;
        resolve_branch_oid(&repo, head)?;
    }
    run_git(repo_path, &["checkout", base])?;
    let merge_message = |verb: &str| format!("{verb} branch '{head}'");
    let result = match method {
        "merge" => run_git(repo_path, &["merge", "--no-ff", head, "-m", &merge_message("Merge")]).map(|_| ()),
        "squash" => run_git(repo_path, &["-c", "merge.ff=true", "merge", "--squash", head])
            .and_then(|_| run_git(repo_path, &["commit", "-m", &merge_message("Squash merge")]))
            .map(|_| ()),
        "rebase" => run_git(repo_path, &["checkout", head])
            .and_then(|_| run_git(repo_path, &["rebase", base]))
            .and_then(|_| run_git(repo_path, &["checkout", base]))
            .and_then(|_| run_git(repo_path, &["merge", "--ff-only", head]))
            .map(|_| ()),
        other => Err(anyhow!("未知合并方式: {other}")),
    };
    if let Err(e) = result {
        // rebase 中断兜底：回到 base 并尝试终止 rebase 状态，避免仓库卡在半途
        if method == "rebase" {
            let _ = run_git(repo_path, &["rebase", "--abort"]);
            let _ = run_git(repo_path, &["checkout", base]);
        }
        return Err(e);
    }
    let repo = open_repo(repo_path)?;
    Ok(resolve_branch_oid(&repo, base)?.to_string())
}

/// 删除分支：默认安全删（`-d`，未合并诚实报错）；force = `-D`（squash
/// 合并不产生祖先关系，内容确认在 base 后需强制删）。
pub fn branch_delete(repo_path: &str, name: &str, force: bool) -> Result<()> {
    let flag = if force { "-D" } else { "-d" };
    run_git(repo_path, &["branch", flag, name]).map(|_| ())
}

#[cfg(test)]
mod file_history_tests {
    use super::*;

    /// 造一个小仓库：a.txt 改两次、b.txt 改一次，并有一个只碰 b 的提交。
    fn seed_repo(dir: &std::path::Path) -> git2::Repository {
        let repo = git2::Repository::init(dir).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "tester").unwrap();
        config.set_str("user.email", "t@example.com").unwrap();
        drop(config);

        let commit = |repo: &git2::Repository, file: &str, content: &str, msg: &str| {
            std::fs::write(dir.join(file), content).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new(file)).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let sig = repo.signature().unwrap();
            let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
            let parents: Vec<&git2::Commit> = parent.iter().collect();
            repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents).unwrap();
        };

        commit(&repo, "a.txt", "1", "a: first");
        commit(&repo, "b.txt", "1", "b: first");
        commit(&repo, "a.txt", "2", "a: second");
        commit(&repo, "b.txt", "2", "b: second");
        repo
    }

    #[test]
    fn file_history_keeps_only_commits_touching_that_file() {
        let dir = std::env::temp_dir().join(format!("hivetask-filehist-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        seed_repo(&dir);
        let path = dir.to_string_lossy().to_string();

        let page = file_history(&path, "a.txt", Some(50)).unwrap();
        let messages: Vec<&str> = page.commits.iter().map(|c| c.message.as_str()).collect();
        assert_eq!(messages, vec!["a: second", "a: first"], "只应包含碰过 a.txt 的提交");

        let b_page = file_history(&path, "b.txt", Some(50)).unwrap();
        let b_messages: Vec<&str> = b_page.commits.iter().map(|c| c.message.as_str()).collect();
        assert_eq!(b_messages, vec!["b: second", "b: first"]);

        // 不存在的路径 → 空历史（不是报错）
        let none = file_history(&path, "nope.md", Some(50)).unwrap();
        assert!(none.commits.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_history_reports_truncation_on_scan_limit() {
        let dir = std::env::temp_dir().join(format!("hivetask-filehist-limit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        seed_repo(&dir);
        let path = dir.to_string_lossy().to_string();

        // 扫描上限 10（下界）→ 4 个提交都在范围内，不应截断
        let page = file_history(&path, "a.txt", Some(10)).unwrap();
        assert!(!page.has_more);
        let _ = std::fs::remove_dir_all(&dir);
    }
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

    // ---- 本地分支 review ----
    // 与 journal 测试共用同一把 libgit2 串行锁
    use crate::journal::tests::TEST_LOCK;

    fn temp_repo() -> (std::path::PathBuf, git2::Repository) {
        let dir = std::env::temp_dir().join(format!(
            "hivetask-review-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut init_opts = git2::RepositoryInitOptions::new();
        init_opts.initial_head("master");
        let repo = git2::Repository::init_opts(&dir, &init_opts).unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("user.name", "tester").unwrap();
        cfg.set_str("user.email", "t@local").unwrap();
        (dir, repo)
    }

    fn write_and_commit(repo: &git2::Repository, path: &str, content: &str, message: &str) -> Oid {
        use std::io::Write as _;
        let workdir = repo.workdir().unwrap();
        let file = workdir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(&file).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        drop(f);
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new(path)).unwrap();
        index.write().unwrap();
        let tree_oid = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_oid).unwrap();
        let sig = repo.signature().unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
            .unwrap()
    }

    fn checkout_branch(repo: &mut git2::Repository, name: &str) {
        let commit = repo.head().unwrap().peel_to_commit().unwrap();
        let branch = repo.branch(name, &commit, false).unwrap();
        repo.checkout_tree(branch.get().peel_to_tree().unwrap().as_object(), None).unwrap();
        repo.set_head(&format!("refs/heads/{name}")).unwrap();
    }

    #[test]
    fn review_list_counts_and_diff() {
        let _g = TEST_LOCK.lock().unwrap();
        let (dir, mut repo) = temp_repo();
        let repo_path = dir.to_str().unwrap();
        write_and_commit(&repo, "a.txt", "one\n", "base");
        checkout_branch(&mut repo, "feature");
        write_and_commit(&repo, "a.txt", "one\ntwo\n", "add line");
        write_and_commit(&repo, "b.txt", "new file\n", "add file");

        let list = review_branch_list(repo_path, "master").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "feature");
        assert_eq!(list[0].ahead, 2);

        let diff = review_diff(repo_path, "master", "feature").unwrap();
        assert!(!diff.up_to_date);
        assert!(diff.mergeable);
        assert!(!diff.conflict);
        assert_eq!(diff.commits.len(), 2);
        let modified = diff.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(modified.additions, 1);
        let added = diff.files.iter().find(|f| f.path == "b.txt").unwrap();
        assert_eq!(added.status, "added");
        assert!(added.patch.as_deref().unwrap_or("").contains("new file"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn conflict_is_detected_honestly() {
        let _g = TEST_LOCK.lock().unwrap();
        let (dir, mut repo) = temp_repo();
        let repo_path = dir.to_str().unwrap();
        write_and_commit(&repo, "c.txt", "line-a\n", "base");
        checkout_branch(&mut repo, "side");
        std::fs::write(dir.join("c.txt"), "line-side\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("c.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = repo.signature().unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "side change", &tree, &[&parent]).unwrap();
        repo.set_head("refs/heads/master").unwrap();
        repo.checkout_head(None).unwrap();
        std::fs::write(dir.join("c.txt"), "line-main\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new("c.txt")).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repo.head().unwrap().peel_to_commit().unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "main change", &tree, &[&parent]).unwrap();

        let diff = review_diff(repo_path, "master", "side").unwrap();
        assert!(diff.conflict);
        assert!(!diff.mergeable);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn merge_flow_squash_and_delete() {
        let _g = TEST_LOCK.lock().unwrap();
        let (dir, mut repo) = temp_repo();
        let repo_path = dir.to_str().unwrap();
        write_and_commit(&repo, "a.txt", "one\n", "base");
        checkout_branch(&mut repo, "feature");
        write_and_commit(&repo, "a.txt", "one\ntwo\n", "feature work");
        // 与生产同径的 shell checkout（安全策略 checkout 不重置 index，会假报脏）
        run_git(repo_path, &["checkout", "master"]).unwrap();

        std::fs::write(dir.join("dirty.txt"), "x").unwrap();
        assert!(review_merge(repo_path, "master", "feature", "merge").is_err());
        std::fs::remove_file(dir.join("dirty.txt")).ok();

        review_merge(repo_path, "master", "feature", "squash").unwrap();
        let content = std::fs::read_to_string(dir.join("a.txt")).unwrap();
        assert!(content.contains("two"));
        // squash 不产生祖先关系：内容已在 base，但分支账面上仍"未合并"
        let diff = review_diff(repo_path, "master", "feature").unwrap();
        assert!(!diff.up_to_date);
        assert!(branch_delete(repo_path, "feature", false).is_err());
        branch_delete(repo_path, "feature", true).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod commit_activity_tests {
    use super::*;

    /// civil_from_days 用已知历元锚点钉死（不依赖时区/当前时钟）。
    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2024-01-01T00:00:00Z = 1_704_067_200 = 19723 天
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        // 1_700_000_000 = 2023-11-14T22:13:20Z → 第 19675 天
        assert_eq!(civil_from_days(1_700_000_000 / 86_400), (2023, 11, 14));
        // 负数分支：1969-12-31 是第 -1 天
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    /// 相对时间戳提交：300 天前（offset 0）与现在（UTC+8 偏移）各一笔，
    /// 断言分桶与窗口截断。固定历元锚点由 civil_from_days_known_dates 钉死。
    #[test]
    fn commit_activity_buckets_by_local_date() {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "tester").unwrap();
        config.set_str("user.email", "t@example.com").unwrap();
        drop(config);

        let commit_at = |repo: &git2::Repository, msg: &str, unix: i64, offset_min: i32| {
            let sig = git2::Signature::new(
                "tester",
                "t@example.com",
                &git2::Time::new(unix, offset_min),
            )
            .unwrap();
            let name = format!("f-{unix}-{offset_min}.txt");
            std::fs::write(dir.path().join(&name), "x").unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new(&name)).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
            let parents: Vec<&git2::Commit> = parent.iter().collect();
            repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents).unwrap();
        };

        let date_of = |unix: i64, offset_min: i32| {
            let (y, m, d) =
                civil_from_days((unix + i64::from(offset_min) * 60).div_euclid(86_400));
            format!("{y:04}-{m:02}-{d:02}")
        };

        // 空仓库 → 空表
        let empty_dir = tempfile::tempdir().unwrap();
        let empty = git2::Repository::init(empty_dir.path()).unwrap();
        drop(empty);
        assert!(
            commit_activity(empty_dir.path().to_str().unwrap(), 365)
                .unwrap()
                .is_empty()
        );

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let old_unix = now - 300 * 86_400; // 窗口内（366 天），offset 0
        let old_date = date_of(old_unix, 0);
        commit_at(&repo, "old", old_unix, 0);
        commit_at(&repo, "now", now, 480); // UTC+8 提交，归日按提交者本地
        let today = date_of(now, 480);

        let path = dir.path().to_str().unwrap();
        let rows = commit_activity(path, 366).unwrap();
        assert_eq!(rows.len(), 2, "应恰有两个日期桶：{rows:?}");
        assert_eq!(
            rows.iter().find(|r| r.date == old_date).map(|r| r.count),
            Some(1),
            "300 天前的提交应落在 {old_date} 桶"
        );
        assert_eq!(
            rows.iter().find(|r| r.date == today).map(|r| r.count),
            Some(1),
            "UTC+8 偏移的今天提交应落在 {today} 桶"
        );
        // 输出按日期升序（BTreeMap 语义，前端直接可用）
        assert!(rows.windows(2).all(|w| w[0].date < w[1].date));

        // 窗口缩到 200 天：只剩今天
        let rows = commit_activity(path, 200).unwrap();
        assert_eq!(rows.len(), 1, "窗口外桶应被截断：{rows:?}");
        assert_eq!(rows[0].date, today);

        std::fs::remove_dir_all(dir.path()).ok();
    }
}
