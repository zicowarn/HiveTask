//! Local cache: `<repo>/.hivetask/hivetask.db` (SQLite).
//!
//! The migration scripts are idempotent (CREATE ... IF NOT EXISTS /
//! INSERT OR IGNORE), so an existing .hivetask/hivetask.db created by an
//! earlier build keeps working, including older databases that track
//! versions in the schema_version table rather than PRAGMA user_version.
//! Migration 003 is an ALTER TABLE guarded solely by the user_version gate,
//! so it runs exactly once.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde_json::json;

use crate::models::{Comment, Issue, Pull};

const MIGRATION_001: &str = include_str!("migrations/001_initial.sql");
const MIGRATION_002: &str = include_str!("migrations/002_projects.sql");
const MIGRATION_003: &str = include_str!("migrations/003_pr_draft.sql");
const MIGRATION_004: &str = include_str!("migrations/004_comments.sql");
const MIGRATION_005: &str = include_str!("migrations/005_meta.sql");
const MIGRATION_006: &str = include_str!("migrations/006_issue_number_text.sql");

/// Latest schema revision tracked through PRAGMA user_version.
const CURRENT_SCHEMA_VERSION: i64 = 6;

pub fn db_path(repo: &Path) -> PathBuf {
    repo.join(".hivetask").join("hivetask.db")
}

/// Open (creating if needed) the per-repo cache database and migrate it.
pub fn open(repo: &Path) -> Result<Connection> {
    let dir = repo.join(".hivetask");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("创建缓存目录失败: {}", dir.display()))?;

    let mut conn = Connection::open(db_path(repo))
        .with_context(|| format!("打开数据库失败: {}", db_path(repo).display()))?;
    conn.pragma_update(None, "foreign_keys", true)?;

    ensure_git_exclude(repo);
    migrate(&mut conn)?;
    Ok(conn)
}

/// Best-effort: keep `.hivetask/` out of `git status` by appending it to the
/// repo-local `.git/info/exclude` (works without touching the user's tracked
/// .gitignore; silently skipped for worktrees where .git is a file).
fn ensure_git_exclude(repo: &Path) {
    let exclude = repo.join(".git").join("info").join("exclude");
    let Ok(_) = std::fs::read_to_string(&exclude) else { return };
    let Ok(existing) = std::fs::read_to_string(&exclude) else { return };
    if existing.lines().any(|line| line.trim() == ".hivetask/") {
        return;
    }
    let mut content = existing;
    if !content.ends_with('\n') && !content.is_empty() {
        content.push('\n');
    }
    content.push_str(".hivetask/\n");
    let _ = std::fs::write(&exclude, content);
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;

    // Legacy databases (schema_version table, user_version == 0) get the
    // idempotent scripts replayed; fresh databases run them in order.
    if version < 1 {
        conn.execute_batch(MIGRATION_001).context("迁移 001 失败")?;
    }
    if version < 2 {
        conn.execute_batch(MIGRATION_002).context("迁移 002 失败")?;
    }
    // ALTER TABLE migrations are not self-idempotent; the user_version gate
    // guarantees a single execution on both fresh and legacy databases.
    if version < 3 {
        conn.execute_batch(MIGRATION_003).context("迁移 003 失败")?;
    }
    if version < 4 {
        conn.execute_batch(MIGRATION_004).context("迁移 004 失败")?;
    }
    if version < 5 {
        conn.execute_batch(MIGRATION_005).context("迁移 005 失败")?;
    }
    if version < 6 {
        conn.execute_batch(MIGRATION_006).context("迁移 006 失败")?;
    }
    conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)?;
    Ok(())
}

/// Full refresh: replace the cached issue set.
///
/// gh returns only the issues matching the requested state filter, so we
/// delete rows for that state and insert the fresh set, leaving cached
/// rows of other states untouched.
pub fn replace_issues(conn: &mut Connection, state: &str, issues: &[Issue]) -> Result<()> {
    let tx = conn.transaction()?;
    if state != "all" {
        tx.execute("DELETE FROM issues WHERE state = ?1", (state.to_uppercase(),))?;
    } else {
        tx.execute("DELETE FROM issues", [])?;
    }
    for issue in issues {
        let labels = json!(issue.labels).to_string();
        let assignees = json!(issue.assignees).to_string();
        tx.execute(
            "INSERT INTO issues
                (number, title, state, body, author, milestone, labels, assignees,
                 created_at, updated_at, url, data_source)
             VALUES
                (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'github')
             ON CONFLICT(number) DO UPDATE SET
                title=excluded.title,
                state=excluded.state,
                body=excluded.body,
                author=excluded.author,
                milestone=excluded.milestone,
                labels=excluded.labels,
                assignees=excluded.assignees,
                created_at=excluded.created_at,
                updated_at=excluded.updated_at,
                url=excluded.url,
                synced_at=datetime('now')",
            rusqlite::params![
                issue.number,
                issue.title,
                issue.state,
                issue.body,
                issue.author,
                issue.milestone,
                labels,
                assignees,
                issue.created_at,
                issue.updated_at,
                issue.url,
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// WHERE clause / bound arguments for a state filter ("open" | "closed" | "all").
fn state_predicate(state: &str) -> (&'static str, Vec<String>) {
    if state == "all" {
        ("", Vec::new())
    } else {
        (" WHERE state = ?1", vec![state.to_uppercase()])
    }
}

/// Count cached issues for a given state filter.
pub fn cached_issue_count(conn: &Connection, state: &str) -> Result<i64> {
    let (predicate, args) = state_predicate(state);
    let sql = format!("SELECT COUNT(*) FROM issues{predicate}");
    conn.query_row(&sql, rusqlite::params_from_iter(args), |row| row.get(0))
        .map_err(Into::into)
}

/// Read cached issues, newest first. TEXT 编号下 `ORDER BY number` 会退化成
/// 字典序（"10" < "9"）：含非数字字符的编号（Gitee "IKCTH7"）排最后，
/// 纯数字编号按「长度优先、再字典」恢复数值序。
pub fn list_issues(conn: &Connection, state: &str) -> Result<Vec<Issue>> {
    let (predicate, args) = state_predicate(state);
    let sql = format!(
        "SELECT number, title, state, body, author, milestone, labels, assignees,
                created_at, updated_at, url
         FROM issues{predicate}
         ORDER BY number GLOB '*[^0-9]*' ASC, length(number) DESC, number DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), map_issue)?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Into::into)
}

fn map_issue(row: &rusqlite::Row<'_>) -> rusqlite::Result<Issue> {
    let labels_json: Option<String> = row.get("labels")?;
    let assignees_json: Option<String> = row.get("assignees")?;
    Ok(Issue {
        number: row.get("number")?,
        title: row.get("title")?,
        state: row.get("state")?,
        body: row.get("body")?,
        author: row.get("author")?,
        milestone: row.get("milestone")?,
        labels: parse_string_array(labels_json),
        assignees: parse_string_array(assignees_json),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        url: row.get("url")?,
    })
}

fn parse_string_array(raw: Option<String>) -> Vec<String> {
    raw.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

/// Replace the cached comments of one entity (kind: "issue" | "pull").
/// number 统一文本口径（issue 为平台原样编号，pull 为十进制文本）。
pub fn replace_comments(
    conn: &mut Connection,
    kind: &str,
    number: &str,
    comments: &[Comment],
) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM comments WHERE kind = ?1 AND number = ?2",
        (kind, number),
    )?;
    for comment in comments {
        tx.execute(
            "INSERT INTO comments (kind, number, author, body, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![kind, number, comment.author, comment.body, comment.created_at],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Read cached comments of one entity, oldest first.
pub fn list_comments(conn: &Connection, kind: &str, number: &str) -> Result<Vec<Comment>> {
    let mut stmt = conn.prepare(
        "SELECT author, body, created_at FROM comments
         WHERE kind = ?1 AND number = ?2
         ORDER BY created_at ASC, rowid ASC",
    )?;
    let rows = stmt.query_map((kind, number), |row| {
        Ok(Comment {
            author: row.get("author")?,
            body: row.get("body")?,
            created_at: row.get("created_at")?,
            pending: false,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Into::into)
}

/// Patch one cached issue's state after a close/reopen mutation.
pub fn update_issue_state(conn: &Connection, number: &str, state: &str) -> Result<()> {
    conn.execute(
        "UPDATE issues SET state = ?1, synced_at = datetime('now') WHERE number = ?2",
        (state, number),
    )?;
    Ok(())
}

/// Stamp a sync key ("synced:<kind>:<state>") with the current UTC time.
pub fn stamp_synced(conn: &Connection, key: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value, synced_at)
         VALUES (?1, strftime('%Y-%m-%dT%H:%M:%SZ','now'), datetime('now'))
         ON CONFLICT(key) DO UPDATE SET
            value=excluded.value,
            synced_at=excluded.synced_at",
        (key,),
    )?;
    Ok(())
}

/// All recorded sync keys and their RFC3339 timestamps.
pub fn list_synced(conn: &Connection) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM meta ORDER BY key")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Into::into)
}

/// Full refresh of the cached PR set, same state-scoped semantics as
/// [`replace_issues`]. `state` may be "open" | "closed" | "merged" | "all".
pub fn replace_pulls(conn: &mut Connection, state: &str, pulls: &[Pull]) -> Result<()> {
    let tx = conn.transaction()?;
    if state != "all" {
        tx.execute("DELETE FROM pulls WHERE state = ?1", (state.to_uppercase(),))?;
    } else {
        tx.execute("DELETE FROM pulls", [])?;
    }
    for pull in pulls {
        upsert_pull(&tx, pull)?;
    }
    tx.commit()?;
    Ok(())
}

/// Insert or replace a single PR row. Used both by the state-scoped bulk
/// refresh (inside its transaction) and by on-demand `gh pr view` detail
/// loads.
pub fn upsert_pull(conn: &Connection, pull: &Pull) -> Result<()> {
    let labels = json!(pull.labels).to_string();
    let assignees = json!(pull.assignees).to_string();
    let reviewers = json!(pull.reviewers).to_string();
    let review_decision = json!(pull.review_decision.iter().collect::<Vec<_>>()).to_string();
    conn.execute(
        "INSERT INTO pulls
            (number, title, state, body, author, head_ref, base_ref, labels, assignees,
             reviewers, review_decision, additions, deletions, commits, comments,
             is_draft, created_at, updated_at, url, data_source)
         VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
             ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, 'github')
         ON CONFLICT(number) DO UPDATE SET
            title=excluded.title,
            state=excluded.state,
            body=excluded.body,
            author=excluded.author,
            head_ref=excluded.head_ref,
            base_ref=excluded.base_ref,
            labels=excluded.labels,
            assignees=excluded.assignees,
            reviewers=excluded.reviewers,
            review_decision=excluded.review_decision,
            additions=excluded.additions,
            deletions=excluded.deletions,
            commits=excluded.commits,
            comments=excluded.comments,
            is_draft=excluded.is_draft,
            created_at=excluded.created_at,
            updated_at=excluded.updated_at,
            url=excluded.url,
            synced_at=datetime('now')",
        rusqlite::params![
            pull.number,
            pull.title,
            pull.state,
            pull.body,
            pull.author,
            pull.head_ref,
            pull.base_ref,
            labels,
            assignees,
            reviewers,
            review_decision,
            pull.additions,
            pull.deletions,
            pull.commits,
            pull.comments,
            pull.is_draft as i64,
            pull.created_at,
            pull.updated_at,
            pull.url,
        ],
    )?;
    Ok(())
}

/// Count cached PRs for a given state filter ("open"|"closed"|"merged"|"all").
pub fn cached_pull_count(conn: &Connection, state: &str) -> Result<i64> {
    let (predicate, args) = state_predicate(state);
    let sql = format!("SELECT COUNT(*) FROM pulls{predicate}");
    conn.query_row(&sql, rusqlite::params_from_iter(args), |row| row.get(0))
        .map_err(Into::into)
}

/// Read cached PRs, newest number first.
pub fn list_pulls(conn: &Connection, state: &str) -> Result<Vec<Pull>> {
    let (predicate, args) = state_predicate(state);
    let sql = format!(
        "SELECT number, title, state, body, author, head_ref, base_ref, labels, assignees,
                reviewers, review_decision, additions, deletions, commits, comments,
                is_draft, created_at, updated_at, url
         FROM pulls{predicate}
         ORDER BY number DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args), map_pull)?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(Into::into)
}

fn map_pull(row: &rusqlite::Row<'_>) -> rusqlite::Result<Pull> {
    let decision_json: Option<String> = row.get("review_decision")?;
    Ok(Pull {
        number: row.get("number")?,
        title: row.get("title")?,
        state: row.get("state")?,
        body: row.get("body")?,
        author: row.get("author")?,
        head_ref: row.get("head_ref")?,
        base_ref: row.get("base_ref")?,
        labels: parse_string_array(row.get("labels")?),
        assignees: parse_string_array(row.get("assignees")?),
        reviewers: parse_string_array(row.get("reviewers")?),
        review_decision: parse_string_array(decision_json).into_iter().next(),
        additions: row.get("additions")?,
        deletions: row.get("deletions")?,
        commits: row.get("commits")?,
        comments: row.get("comments")?,
        is_draft: row.get::<_, i64>("is_draft")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        url: row.get("url")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hivetask-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_issue(number: &str, state: &str) -> Issue {
        Issue {
            number: number.to_string(),
            title: format!("issue {number}"),
            state: state.to_string(),
            body: Some("body text".into()),
            author: Some("zicowarn".into()),
            milestone: None,
            labels: vec!["bug".into()],
            assignees: vec![],
            created_at: None,
            updated_at: None,
            url: None,
        }
    }

    #[test]
    fn migrate_is_idempotent_across_opens() {
        let repo = temp_repo();
        {
            let mut conn = open(&repo).unwrap();
            replace_issues(&mut conn, "open", &[sample_issue("1", "OPEN")]).unwrap();
        }
        // Reopen must replay idempotent scripts without error.
        let conn = open(&repo).unwrap();
        let version: i64 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
        assert_eq!(cached_issue_count(&conn, "all").unwrap(), 1);
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn refresh_replaces_only_requested_state() {
        let repo = temp_repo();
        let mut conn = open(&repo).unwrap();

        replace_issues(
            &mut conn,
            "open",
            &[sample_issue("1", "OPEN"), sample_issue("2", "OPEN")],
        )
        .unwrap();
        replace_issues(&mut conn, "closed", &[sample_issue("9", "CLOSED")]).unwrap();
        assert_eq!(cached_issue_count(&conn, "all").unwrap(), 3);

        // Re-sync open: stale open rows removed/replaced, closed row survives.
        replace_issues(&mut conn, "open", &[sample_issue("3", "OPEN")]).unwrap();
        assert_eq!(cached_issue_count(&conn, "all").unwrap(), 2);
        assert_eq!(cached_issue_count(&conn, "closed").unwrap(), 1);

        let open_issues = list_issues(&conn, "open").unwrap();
        assert_eq!(open_issues.len(), 1);
        assert_eq!(open_issues[0].number, "3");
        assert_eq!(open_issues[0].labels, vec!["bug".to_string()]);

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn text_numbers_sort_numerically() {
        let repo = temp_repo();
        let mut conn = open(&repo).unwrap();
        replace_issues(
            &mut conn,
            "open",
            &[
                sample_issue("10", "OPEN"),
                sample_issue("2", "OPEN"),
                sample_issue("1", "OPEN"),
                sample_issue("IKCTH7", "OPEN"),
            ],
        )
        .unwrap();
        let numbers: Vec<String> =
            list_issues(&conn, "open").unwrap().into_iter().map(|i| i.number).collect();
        // 纯数字编号按数值序（长度优先再字典），字母编号字典序兜底在最后。
        assert_eq!(numbers, vec!["10", "2", "1", "IKCTH7"]);
        std::fs::remove_dir_all(&repo).ok();
    }

    fn sample_pull(number: i64, state: &str) -> Pull {
        Pull {
            number,
            title: format!("pull {number}"),
            state: state.to_string(),
            body: Some("pr body".into()),
            author: Some("zicowarn".into()),
            head_ref: Some("feature".into()),
            base_ref: Some("main".into()),
            labels: vec!["refactor".into()],
            assignees: vec![],
            reviewers: vec!["reviewer1".into()],
            review_decision: Some("APPROVED".into()),
            additions: 10,
            deletions: 4,
            commits: 2,
            comments: 1,
            is_draft: false,
            created_at: None,
            updated_at: None,
            url: None,
        }
    }

    #[test]
    fn pull_refresh_round_trips_and_is_state_scoped() {
        let repo = temp_repo();
        let mut conn = open(&repo).unwrap();

        replace_pulls(
            &mut conn,
            "open",
            &[sample_pull(1, "OPEN"), sample_pull(2, "OPEN")],
        )
        .unwrap();
        replace_pulls(&mut conn, "merged", &[sample_pull(9, "MERGED")]).unwrap();
        assert_eq!(cached_pull_count(&conn, "all").unwrap(), 3);
        assert_eq!(cached_pull_count(&conn, "merged").unwrap(), 1);

        // Resync open: merged row survives; is_draft column (migration 003)
        // survives the round trip.
        let mut draft = sample_pull(3, "OPEN");
        draft.is_draft = true;
        replace_pulls(&mut conn, "open", &[draft]).unwrap();
        assert_eq!(cached_pull_count(&conn, "all").unwrap(), 2);

        let open = list_pulls(&conn, "open").unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].number, 3);
        assert!(open[0].is_draft);
        assert_eq!(open[0].review_decision.as_deref(), Some("APPROVED"));
        assert_eq!(open[0].head_ref.as_deref(), Some("feature"));

        std::fs::remove_dir_all(&repo).ok();
    }
}

#[cfg(test)]
mod comment_tests {
    use super::*;
    use crate::models::Comment;

    fn temp_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hivetask-comments-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn comment(author: &str, created_at: &str) -> Comment {
        Comment {
            author: Some(author.into()),
            body: Some(format!("body by {author}")),
            created_at: Some(created_at.into()),
            pending: false,
        }
    }

    #[test]
    fn comments_roundtrip_per_entity() {
        let repo = temp_repo();
        let mut conn = open(&repo).unwrap();

        replace_comments(
            &mut conn,
            "issue",
            "42",
            &[comment("alice", "2026-09-01T10:00:00Z"), comment("bob", "2026-09-02T11:00:00Z")],
        )
        .unwrap();
        // A PR with the same number must not bleed across kinds.
        replace_comments(&mut conn, "pull", "42", &[comment("carol", "2026-09-03T09:00:00Z")]).unwrap();

        let issue_comments = list_comments(&conn, "issue", "42").unwrap();
        assert_eq!(issue_comments.len(), 2);
        assert_eq!(issue_comments[0].author.as_deref(), Some("alice"));
        let pull_comments = list_comments(&conn, "pull", "42").unwrap();
        assert_eq!(pull_comments.len(), 1);
        assert_eq!(pull_comments[0].author.as_deref(), Some("carol"));

        // Re-sync replaces wholesale instead of appending.
        replace_comments(&mut conn, "issue", "42", &[comment("dave", "2026-09-04T08:00:00Z")]).unwrap();
        let resynced = list_comments(&conn, "issue", "42").unwrap();
        assert_eq!(resynced.len(), 1);
        assert_eq!(resynced[0].author.as_deref(), Some("dave"));

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn update_issue_state_patches_cached_row() {
        let repo = temp_repo();
        let mut conn = open(&repo).unwrap();
        let issues = vec![Issue {
            number: "7".to_string(),
            title: "issue 7".into(),
            state: "OPEN".into(),
            body: None,
            author: None,
            milestone: None,
            labels: vec![],
            assignees: vec![],
            created_at: None,
            updated_at: None,
            url: None,
        }];
        replace_issues(&mut conn, "open", &issues).unwrap();

        update_issue_state(&conn, "7", "CLOSED").unwrap();
        let open_bucket = list_issues(&conn, "open").unwrap();
        assert!(open_bucket.is_empty());
        let closed_bucket = list_issues(&conn, "closed").unwrap();
        assert_eq!(closed_bucket.len(), 1);
        assert_eq!(closed_bucket[0].state, "CLOSED");

        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn migration_006_casts_legacy_integer_numbers() {
        let repo = temp_repo();
        let dir = repo.join(".hivetask");
        std::fs::create_dir_all(&dir).unwrap();
        {
            let mut conn = Connection::open(dir.join("hivetask.db")).unwrap();
            // 模拟 v5 存量库：整数主键的 issue/comment 行
            for sql in [MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005] {
                conn.execute_batch(sql).unwrap();
            }
            conn.execute_batch(
                "INSERT INTO issues (number, title, state) VALUES (7, 'legacy', 'OPEN');
                 INSERT INTO comments (kind, number, author, body)
                 VALUES ('issue', 7, 'alice', 'hi');",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 5).unwrap();
        }
        // open() 执行 006：整数编号无损转文本
        let conn = open(&repo).unwrap();
        let issues = list_issues(&conn, "open").unwrap();
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].number, "7");
        let comments = list_comments(&conn, "issue", "7").unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].author.as_deref(), Some("alice"));
        std::fs::remove_dir_all(&repo).ok();
    }
}

#[cfg(test)]
mod meta_tests {
    use super::*;

    fn temp_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hivetask-meta-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn synced_stamps_upsert_and_roundtrip() {
        let repo = temp_repo();
        let conn = open(&repo).unwrap();

        stamp_synced(&conn, "synced:issues:open").unwrap();
        stamp_synced(&conn, "synced:pulls:open").unwrap();
        // Re-stamping the same key overwrites, not duplicates.
        stamp_synced(&conn, "synced:issues:open").unwrap();

        let map = list_synced(&conn).unwrap();
        assert_eq!(map.len(), 2);
        let (key, value) = map.iter().find(|(k, _)| k == "synced:issues:open").unwrap();
        assert_eq!(key, "synced:issues:open");
        // RFC3339 shape from strftime.
        assert!(value.ends_with('Z') && value.contains('T'), "got {value}");

        std::fs::remove_dir_all(&repo).ok();
    }
}

#[cfg(test)]
mod exclude_tests {
    use super::*;

    fn temp_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hivetask-excl-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn hivetask_excluded_once() {
        let repo = temp_repo();
        // init a real git repo so .git/info/ exists
        git2::Repository::init(&repo).unwrap();
        open(&repo).unwrap();
        open(&repo).unwrap(); // idempotent second open

        let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.lines().filter(|l| l.trim() == ".hivetask/").count(), 1);

        // A repo without .git dir must not crash storage::open.
        let plain = std::env::temp_dir().join(format!("hivetask-plain-{}", std::process::id()));
        std::fs::create_dir_all(&plain).unwrap();
        let _ = open(&plain);
        std::fs::remove_dir_all(&plain).ok();
        std::fs::remove_dir_all(&repo).ok();
    }
}
