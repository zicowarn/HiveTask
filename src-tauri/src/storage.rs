//! Local cache: `<repo>/.hivetask/hivetask.db` (SQLite).
//!
//! The migration scripts are idempotent (CREATE ... IF NOT EXISTS /
//! INSERT OR IGNORE), so an existing .hivetask/hivetask.db created by an
//! earlier build keeps working, including older databases that track
//! versions in the schema_version table rather than PRAGMA user_version.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::Connection;
use serde_json::json;

use crate::models::Issue;

const MIGRATION_001: &str = include_str!("migrations/001_initial.sql");
const MIGRATION_002: &str = include_str!("migrations/002_projects.sql");

/// Latest schema revision tracked through PRAGMA user_version.
const CURRENT_SCHEMA_VERSION: i64 = 2;

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

    migrate(&mut conn)?;
    Ok(conn)
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

/// Read cached issues, newest number first.
pub fn list_issues(conn: &Connection, state: &str) -> Result<Vec<Issue>> {
    let (predicate, args) = state_predicate(state);
    let sql = format!(
        "SELECT number, title, state, body, author, milestone, labels, assignees,
                created_at, updated_at, url
         FROM issues{predicate}
         ORDER BY number DESC"
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

    fn sample_issue(number: i64, state: &str) -> Issue {
        Issue {
            number,
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
            replace_issues(&mut conn, "open", &[sample_issue(1, "OPEN")]).unwrap();
        }
        // Reopen must replay idempotent scripts without error.
        let conn = open(&repo).unwrap();
        let version: i64 =
            conn.pragma_query_value(None, "user_version", |row| row.get(0)).unwrap();
        assert_eq!(version, 2);
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
            &[sample_issue(1, "OPEN"), sample_issue(2, "OPEN")],
        )
        .unwrap();
        replace_issues(&mut conn, "closed", &[sample_issue(9, "CLOSED")]).unwrap();
        assert_eq!(cached_issue_count(&conn, "all").unwrap(), 3);

        // Re-sync open: stale open rows removed/replaced, closed row survives.
        replace_issues(&mut conn, "open", &[sample_issue(3, "OPEN")]).unwrap();
        assert_eq!(cached_issue_count(&conn, "all").unwrap(), 2);
        assert_eq!(cached_issue_count(&conn, "closed").unwrap(), 1);

        let open_issues = list_issues(&conn, "open").unwrap();
        assert_eq!(open_issues.len(), 1);
        assert_eq!(open_issues[0].number, 3);
        assert_eq!(open_issues[0].labels, vec!["bug".to_string()]);

        std::fs::remove_dir_all(&repo).ok();
    }
}
