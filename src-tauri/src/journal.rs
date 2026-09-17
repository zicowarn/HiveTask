//! 本地 Issue 事件日志（`refs/hivetask/issues`）——持久真源。
//!
//! 设计定案（知识库《本地Issue与本地分支Review》）：每个 issue 操作 append
//! 一个事件 commit 到隐藏引用，SQLite `.hivetask/hivetask.db` 是物化视图。
//! 读走 SQLite；写 = journal + SQLite 双落点（`sync` 重放幂等：编号随事件
//! 持久化，全量重放不产生漂移）。共享开关只管传输，不影响本模块——日志
//! 无论是否共享都始终写。
//!
//! git2 写路径只动 tree/blob/ref，不碰 index 与工作区；签名取仓库
//! `user.name/email`，缺省回落 "hivetask"。

use anyhow::{anyhow, Context, Result};
use git2::Repository;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::storage;

/// 隐藏引用：事件追加为 commit 链，真源锚点。
pub const REF: &str = "refs/hivetask/issues";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    /// "issue.create" | "issue.comment" | "issue.state" | "issue.edit"
    /// | "issue.labels" | "issue.assignees" | "issue.milestone"
    pub action: String,
    pub number: String,
    pub author: String,
    /// RFC3339 形态 UTC 时间戳（与 meta 表口径一致）。
    pub ts: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// "OPEN" | "CLOSED"（issue.state 事件）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// 整体替换的标签（issue.labels 事件；None = 不改）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    /// 整体替换的负责人（issue.assignees 事件；None = 不改）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignees: Option<Vec<String>>,
    /// 创建时归属的里程碑（旧事件缺省 None，重放兼容）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub milestone: Option<String>,
}

/// 当前作者身份：仓库 git config 的 user.name，缺省 "hivetask"。
pub fn current_author(workdir: &Path) -> String {
    Repository::open(workdir)
        .ok()
        .and_then(|repo| {
            repo.config()
                .ok()?
                .get_string("user.name")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| "hivetask".to_string())
}

/// 本地 Issue 编号水位（meta 表自增），创建时分配并写进事件——重放直接
/// 采用事件内编号，保证幂等。
pub fn next_number(conn: &Connection) -> Result<String> {
    let current: i64 = storage::meta_get(conn, "issue_seq")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let next = current + 1;
    storage::meta_set(conn, "issue_seq", &next.to_string())?;
    Ok(next.to_string())
}

/// Append 一个事件 commit 到 `refs/hivetask/issues`（blob(事件 JSON) →
/// treebuilder → commit，parent 为当前 ref 顶）。
pub fn append(workdir: &Path, event: &Event) -> Result<()> {
    let repo = Repository::open(workdir)
        .with_context(|| format!("打开仓库失败: {}", workdir.display()))?;
    let json = serde_json::to_vec(event)?;
    let blob = repo.blob(&json)?;
    let mut builder = repo.treebuilder(None)?;
    builder.insert("event.json", blob, git2::FileMode::Blob.into())?;
    let tree = repo.find_tree(builder.write()?)?;

    let parent = repo
        .find_reference(REF)
        .ok()
        .and_then(|r| r.peel_to_commit().ok());
    let parents: Vec<&git2::Commit> = parent.iter().collect();

    let sig = signature(&repo)?;
    // commit(Some(refname)) 在创建提交的同时把 ref 推进到它——append 语义。
    repo.commit(Some(REF), &sig, &sig, &event.action, &tree, &parents)?;
    Ok(())
}

/// 签名：仓库配置优先，缺省 hivetask <hivetask@local>。
fn signature(repo: &Repository) -> Result<git2::Signature<'static>> {
    let config = repo.config()?;
    let name = config.get_string("user.name").ok().filter(|s| !s.trim().is_empty());
    let email = config.get_string("user.email").ok().filter(|s| !s.trim().is_empty());
    Ok(git2::Signature::now(
        name.as_deref().unwrap_or("hivetask"),
        email.as_deref().unwrap_or("hivetask@local"),
    )?)
}

/// 按提交序（旧 → 新）读取全部事件。
fn read_events(repo: &Repository) -> Result<Vec<Event>> {
    let Ok(reference) = repo.find_reference(REF) else {
        return Ok(Vec::new());
    };
    let tip = reference.peel_to_commit()?;
    let mut revwalk = repo.revwalk()?;
    revwalk.push(tip.id())?;
    let mut events = Vec::new();
    for oid in revwalk {
        let commit = repo.find_commit(oid?)?;
        let entry = commit.tree()?.get_path(std::path::Path::new("event.json"))?;
        let blob = repo.find_blob(entry.id())?;
        let event: Event = serde_json::from_slice(blob.content())
            .with_context(|| format!("解析事件失败: {}", commit.id()))?;
        events.push(event);
    }
    // revwalk 是新 → 旧；重放按提交序（旧 → 新）。
    events.reverse();
    Ok(events)
}

/// 把 journal 重放到 SQLite 物化视图（全量重放，天然幂等）。ref 顶与
/// meta 记录一致时为 no-op；本地仓库的每次读操作前都应调用。
pub fn sync(workdir: &Path, conn: &mut Connection) -> Result<()> {
    let repo = Repository::open(workdir)?;
    let head = repo
        .find_reference(REF)
        .ok()
        .and_then(|r| r.peel_to_commit().ok())
        .map(|c| c.id().to_string());
    let applied = storage::meta_get(conn, "journal_applied")?;
    if head == applied {
        return Ok(());
    }
    storage::reset_issue_material(conn)?;
    for event in read_events(&repo)? {
        apply(conn, &event)?;
    }
    // 空 journal（无 ref）也记录空串，避免每次读都白跑重放。
    storage::meta_set(conn, "journal_applied", head.as_deref().unwrap_or(""))?;
    Ok(())
}

/// 单事件应用到物化视图。
fn apply(conn: &Connection, event: &Event) -> Result<()> {
    match event.action.as_str() {
        "issue.create" => {
            storage::upsert_issue(
                conn,
                &crate::models::Issue {
                    number: event.number.clone(),
                    title: event.title.clone().unwrap_or_default(),
                    state: "OPEN".to_string(),
                    body: event.body.clone(),
                    author: Some(event.author.clone()),
                    milestone: event.milestone.clone(),
                    labels: Vec::new(),
                    assignees: Vec::new(),
                    created_at: Some(event.ts.clone()),
                    updated_at: Some(event.ts.clone()),
                    url: None,
                },
                "local",
            )?;
        }
        "issue.comment" => {
            let body = event
                .body
                .clone()
                .ok_or_else(|| anyhow!("issue.comment 事件缺少 body"))?;
            storage::append_comment(
                conn,
                "issue",
                &event.number,
                Some(&event.author),
                &body,
                &event.ts,
            )?;
        }
        "issue.state" => {
            let state = event
                .state
                .clone()
                .ok_or_else(|| anyhow!("issue.state 事件缺少 state"))?;
            storage::update_issue_state(conn, &event.number, &state)?;
        }
        "issue.edit" => {
            // 编辑 = 覆写物化视图的标题/正文（last-writer-wins，与平台口径一致）。
            let title = event
                .title
                .clone()
                .ok_or_else(|| anyhow!("issue.edit 事件缺少 title"))?;
            conn.execute(
                "UPDATE issues SET title = ?1, body = ?2, synced_at = datetime('now') WHERE number = ?3",
                (title, event.body.clone(), event.number.clone()),
            )?;
        }
        "issue.labels" => {
            let labels = event
                .labels
                .clone()
                .ok_or_else(|| anyhow!("issue.labels 事件缺少 labels"))?;
            conn.execute(
                "UPDATE issues SET labels = ?1, synced_at = datetime('now') WHERE number = ?2",
                (serde_json::json!(labels).to_string(), event.number.clone()),
            )?;
        }
        "issue.assignees" => {
            let assignees = event
                .assignees
                .clone()
                .ok_or_else(|| anyhow!("issue.assignees 事件缺少 assignees"))?;
            conn.execute(
                "UPDATE issues SET assignees = ?1, synced_at = datetime('now') WHERE number = ?2",
                (serde_json::json!(assignees).to_string(), event.number.clone()),
            )?;
        }
        "issue.milestone" => {
            // milestone 为 None = 清除归属（列置 NULL）。
            conn.execute(
                "UPDATE issues SET milestone = ?1, synced_at = datetime('now') WHERE number = ?2",
                (event.milestone.clone(), event.number.clone()),
            )?;
        }
        other => anyhow::bail!("未知事件类型: {other}"),
    }
    Ok(())
}

/// 创建一条本地 Issue：分配编号 → append 事件 → 写物化视图 → 返回实体。
pub fn create_issue(
    workdir: &Path,
    conn: &mut Connection,
    title: &str,
    body: Option<&str>,
    author: &str,
    milestone: Option<&str>,
) -> Result<crate::models::Issue> {
    if title.trim().is_empty() {
        return Err(anyhow!("标题不能为空"));
    }
    let number = next_number(conn)?;
    let ts = crate::appdb::chrono_like_now();
    let event = Event {
        action: "issue.create".to_string(),
        number: number.clone(),
        author: author.to_string(),
        ts,
        title: Some(title.trim().to_string()),
        body: body.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()),
        state: None,
        labels: None,
        assignees: None,
        milestone: milestone.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()),
    };
    append(workdir, &event)?;
    apply(conn, &event)?;
    storage::get_issue(conn, &number)?
        .ok_or_else(|| anyhow!("创建后未找到 issue #{number}"))
}

/// 追加一条评论（journal + 物化双写）并返回该实体的完整会话。
pub fn add_comment(
    workdir: &Path,
    conn: &mut Connection,
    number: &str,
    body: &str,
    author: &str,
) -> Result<Vec<crate::models::Comment>> {
    if body.trim().is_empty() {
        return Err(anyhow!("评论内容不能为空"));
    }
    let event = Event {
        action: "issue.comment".to_string(),
        number: number.to_string(),
        author: author.to_string(),
        ts: crate::appdb::chrono_like_now(),
        title: None,
        body: Some(body.trim().to_string()),
        state: None,
        labels: None,
        assignees: None,
        milestone: None,
    };
    append(workdir, &event)?;
    storage::append_comment(conn, "issue", number, Some(author), body.trim(), &event.ts)?;
    storage::list_comments(conn, "issue", number)
}

/// 关闭/重开（journal + 物化双写）并返回更新后的实体。
pub fn set_issue_state(
    workdir: &Path,
    conn: &mut Connection,
    number: &str,
    closed: bool,
    author: &str,
) -> Result<crate::models::Issue> {
    let state = if closed { "CLOSED" } else { "OPEN" };
    let event = Event {
        action: "issue.state".to_string(),
        number: number.to_string(),
        author: author.to_string(),
        ts: crate::appdb::chrono_like_now(),
        title: None,
        body: None,
        state: Some(state.to_string()),
        labels: None,
        assignees: None,
        milestone: None,
    };
    append(workdir, &event)?;
    storage::update_issue_state(conn, number, state)?;
    storage::get_issue(conn, number)?
        .ok_or_else(|| anyhow!("issue #{number} 不存在"))
}

/// 编辑标题/正文（journal + 物化双写）并返回更新后的实体。
pub fn edit_issue(
    workdir: &Path,
    conn: &mut Connection,
    number: &str,
    title: &str,
    body: Option<&str>,
    author: &str,
) -> Result<crate::models::Issue> {
    if title.trim().is_empty() {
        return Err(anyhow!("标题不能为空"));
    }
    let event = Event {
        action: "issue.edit".to_string(),
        number: number.to_string(),
        author: author.to_string(),
        ts: crate::appdb::chrono_like_now(),
        title: Some(title.trim().to_string()),
        body: body.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()),
        state: None,
        labels: None,
        assignees: None,
        milestone: None,
    };
    append(workdir, &event)?;
    apply(conn, &event)?;
    storage::get_issue(conn, number)?
        .ok_or_else(|| anyhow!("issue #{number} 不存在"))
}

/// 整体替换标签（本地 Issue；append → 物化视图 → 回读）。
pub fn set_issue_labels(
    workdir: &Path,
    conn: &mut Connection,
    number: &str,
    labels: &[String],
    author: &str,
) -> Result<crate::models::Issue> {
    let event = Event {
        action: "issue.labels".to_string(),
        number: number.to_string(),
        author: author.to_string(),
        ts: crate::appdb::chrono_like_now(),
        title: None,
        body: None,
        state: None,
        labels: Some(labels.to_vec()),
        assignees: None,
        milestone: None,
    };
    append(workdir, &event)?;
    apply(conn, &event)?;
    storage::get_issue(conn, number)?.ok_or_else(|| anyhow!("issue #{number} 不存在"))
}

/// 整体替换负责人（本地 Issue）。
pub fn set_issue_assignees(
    workdir: &Path,
    conn: &mut Connection,
    number: &str,
    assignees: &[String],
    author: &str,
) -> Result<crate::models::Issue> {
    let event = Event {
        action: "issue.assignees".to_string(),
        number: number.to_string(),
        author: author.to_string(),
        ts: crate::appdb::chrono_like_now(),
        title: None,
        body: None,
        state: None,
        labels: None,
        assignees: Some(assignees.to_vec()),
        milestone: None,
    };
    append(workdir, &event)?;
    apply(conn, &event)?;
    storage::get_issue(conn, number)?.ok_or_else(|| anyhow!("issue #{number} 不存在"))
}

/// 设置/清除里程碑归属（本地 = Issue 上的纯文本标签；None = 清除）。
pub fn set_issue_milestone(
    workdir: &Path,
    conn: &mut Connection,
    number: &str,
    milestone: Option<&str>,
    author: &str,
) -> Result<crate::models::Issue> {
    let event = Event {
        action: "issue.milestone".to_string(),
        number: number.to_string(),
        author: author.to_string(),
        ts: crate::appdb::chrono_like_now(),
        title: None,
        body: None,
        state: None,
        labels: None,
        assignees: None,
        milestone: milestone.map(|m| m.trim().to_string()).filter(|m| !m.is_empty()),
    };
    append(workdir, &event)?;
    apply(conn, &event)?;
    storage::get_issue(conn, number)?.ok_or_else(|| anyhow!("issue #{number} 不存在"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// libgit2 部分全局状态（mwindow 等）在并行测试下偶发互踩——
    /// 全 crate 一把锁（git.rs 的 review 测试共用）。
    pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn temp_workdir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hivetask-journal-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Repository::init(&dir).unwrap();
        dir
    }

    fn open_material(workdir: &Path) -> Connection {
        // storage::open 与生产同构：建 .hivetask/hivetask.db + 全迁移
        storage::open(workdir).unwrap()
    }

    #[test]
    fn journal_roundtrip_replay_is_idempotent() {
        let _guard = TEST_LOCK.lock().unwrap();
        let workdir = temp_workdir();
        let mut conn = open_material(&workdir);

        // 创建 → 评论 ×2 → 关闭
        let issue = create_issue(&workdir, &mut conn, "第一条", Some("正文"), "tester", None).unwrap();
        assert_eq!(issue.number, "1");
        assert_eq!(issue.title, "第一条");
        add_comment(&workdir, &mut conn, "1", "评论一", "tester").unwrap();
        add_comment(&workdir, &mut conn, "1", "评论二", "tester").unwrap();
        set_issue_state(&workdir, &mut conn, "1", true, "tester").unwrap();

        // 物化视图已有最终态
        assert_eq!(storage::list_comments(&conn, "issue", "1").unwrap().len(), 2);
        assert_eq!(storage::get_issue(&conn, "1").unwrap().unwrap().state, "CLOSED");

        // 模拟物化丢失：清空后 sync 全量重放恢复
        storage::reset_issue_material(&conn).unwrap();
        storage::meta_set(&conn, "journal_applied", "").unwrap();
        sync(&workdir, &mut conn).unwrap();
        assert_eq!(storage::get_issue(&conn, "1").unwrap().unwrap().state, "CLOSED");
        assert_eq!(storage::list_comments(&conn, "issue", "1").unwrap().len(), 2);

        // ref 顶未变 → sync no-op（幂等，不产生重复行）
        sync(&workdir, &mut conn).unwrap();
        assert_eq!(storage::list_comments(&conn, "issue", "1").unwrap().len(), 2);

        // 事件链真实存在且可从 git 读出
        let repo = Repository::open(&workdir).unwrap();
        assert!(repo.find_reference(REF).is_ok());
        assert_eq!(read_events(&repo).unwrap().len(), 4);

        std::fs::remove_dir_all(&workdir).ok();
    }

    /// 标签 / 负责人 / 里程碑三个编辑事件：写入生效 + 清空 + 物化丢失后重放恢复。
    #[test]
    fn field_edit_events_replay() {
        let _guard = TEST_LOCK.lock().unwrap();
        let workdir = temp_workdir();
        let mut conn = open_material(&workdir);

        create_issue(&workdir, &mut conn, "字段编辑", None, "tester", None).unwrap();
        set_issue_labels(
            &workdir,
            &mut conn,
            "1",
            &["bug".to_string(), "docs".to_string()],
            "tester",
        )
        .unwrap();
        set_issue_assignees(&workdir, &mut conn, "1", &["alice".to_string()], "tester").unwrap();
        set_issue_milestone(&workdir, &mut conn, "1", Some("v1.0"), "tester").unwrap();

        let issue = storage::get_issue(&conn, "1").unwrap().unwrap();
        assert_eq!(issue.labels, vec!["bug".to_string(), "docs".to_string()]);
        assert_eq!(issue.assignees, vec!["alice".to_string()]);
        assert_eq!(issue.milestone.as_deref(), Some("v1.0"));

        // 清空（空数组 / None）同样落事件
        set_issue_labels(&workdir, &mut conn, "1", &[], "tester").unwrap();
        set_issue_milestone(&workdir, &mut conn, "1", None, "tester").unwrap();
        let issue = storage::get_issue(&conn, "1").unwrap().unwrap();
        assert!(issue.labels.is_empty());
        assert!(issue.milestone.is_none());

        // 物化丢失 → sync 全量重放，最终态一致（重放幂等）
        storage::reset_issue_material(&conn).unwrap();
        storage::meta_set(&conn, "journal_applied", "").unwrap();
        sync(&workdir, &mut conn).unwrap();
        let replayed = storage::get_issue(&conn, "1").unwrap().unwrap();
        assert!(replayed.labels.is_empty());
        assert_eq!(replayed.assignees, vec!["alice".to_string()]);
        assert!(replayed.milestone.is_none());

        // 事件数：create + labels×2 + assignees + milestone×2 = 6
        let repo = Repository::open(&workdir).unwrap();
        assert_eq!(read_events(&repo).unwrap().len(), 6);

        std::fs::remove_dir_all(&workdir).ok();
    }

    #[test]
    fn numbers_increase_across_creates() {
        let _guard = TEST_LOCK.lock().unwrap();
        let workdir = temp_workdir();
        let mut conn = open_material(&workdir);
        create_issue(&workdir, &mut conn, "a", None, "t", None).unwrap();
        let second = create_issue(&workdir, &mut conn, "b", None, "t", None).unwrap();
        assert_eq!(second.number, "2");
        std::fs::remove_dir_all(&workdir).ok();
    }
}
