//! Projects 本地看板（P4 v1）——应用级真源（app.db 四表，migration 002）。
//!
//! 设计定案（知识库《架构设计-Projects本地看板》）：状态列不是硬编码而是
//! builtin_status 单选字段的 options；列内排序用 rank 分数索引（拖拽取相邻
//! 中值）；item 三形态 issue/pull/draft；仓库删除后条目悬挂 = ghost（读取
//! 时 LEFT JOIN 判定，删除时不级联）；「关闭→Done」是唯一的 v1 自动化。

use rusqlite::Connection;
use serde::Serialize;

use crate::appdb::{chrono_like_now, uuid};

// ---- 数据形状 ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub group_tag: Option<String>,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct FieldOption {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectField {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub name: String,
    pub options: Vec<FieldOption>,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectItem {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    /// kind=issue|pull 时非空；悬挂（仓库已删）= ghost。
    pub repo_id: Option<String>,
    pub number: Option<String>,
    pub draft_title: Option<String>,
    pub draft_body: Option<String>,
    pub rank: String,
    pub added_at: String,
    /// JOIN 派生：仓库显示名（ghost 时 None）。
    pub repo_label: Option<String>,
    /// JOIN 派生：仓库登记的 remote_url（meta 行显示用）。
    pub ghost: bool,
    /// 字段值 map（field_id → value）。
    pub field_values: std::collections::BTreeMap<String, String>,
}

/// rank 间距基数：新条目追加为 max+GAP；中值插入不足时全列重排。
const RANK_GAP: i64 = 1024;

fn parse_rank(rank: &str) -> i64 {
    rank.parse().unwrap_or(0)
}

// ---- 行映射 ----

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get("id")?,
        display_name: row.get("display_name")?,
        description: row.get("description")?,
        group_tag: row.get("group_tag")?,
        archived: row.get::<_, i64>("archived")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn parse_options(raw: Option<String>) -> Vec<FieldOption> {
    raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn field_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectField> {
    Ok(ProjectField {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        kind: row.get("kind")?,
        name: row.get("name")?,
        options: parse_options(row.get("options")?),
        position: row.get("position")?,
    })
}

// ---- 项目 CRUD ----

fn now() -> String {
    chrono_like_now()
}

pub fn project_create_in(conn: &Connection, name: &str, description: Option<&str>) -> Result<Project, String> {
    if name.trim().is_empty() {
        return Err("项目名不能为空".to_string());
    }
    let id = uuid();
    conn.execute(
        "INSERT INTO projects (id, display_name, description, created_at, updated_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?1, ?1, ?1)",
        rusqlite::params![id, name.trim(), description],
    )
    .map_err(|e| e.to_string())?;
    seed_fields(conn, &id)?;
    project_get_in(conn, &id)
}

/// 种子字段：builtin_status（Todo/In Progress/Done）+ 优先级单选。
/// 列名可改（field options 重写即可），自动化按名匹配 "Done"。
fn seed_fields(conn: &Connection, project_id: &str) -> Result<(), String> {
    let status = serde_json::to_string(&[
        FieldOption { id: format!("{project_id}-s1"), name: "Todo".into(), color: "#8b949e".into() },
        FieldOption { id: format!("{project_id}-s2"), name: "In Progress".into(), color: "#d29922".into() },
        FieldOption { id: format!("{project_id}-s3"), name: "Done".into(), color: "#3fb950".into() },
    ])
    .map_err(|e| e.to_string())?;
    let priority = serde_json::to_string(&[
        FieldOption { id: format!("{project_id}-p1"), name: "P0".into(), color: "#f85149".into() },
        FieldOption { id: format!("{project_id}-p2"), name: "P1".into(), color: "#d29922".into() },
        FieldOption { id: format!("{project_id}-p3"), name: "P2".into(), color: "#8b949e".into() },
    ])
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO project_fields (id, project_id, kind, name, options, position)
         VALUES (?1, ?2, 'builtin_status', 'Status', ?3, 0),
                (?4, ?2, 'single_select', '优先级', ?5, 1)",
        rusqlite::params![format!("{project_id}-f1"), project_id, status, format!("{project_id}-f2"), priority],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn project_list_in(conn: &Connection, include_archived: bool) -> Result<Vec<Project>, String> {
    let sql = if include_archived {
        "SELECT * FROM projects ORDER BY last_opened_at DESC"
    } else {
        "SELECT * FROM projects WHERE archived = 0 ORDER BY last_opened_at DESC"
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], project_from_row).map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn project_get_in(conn: &Connection, id: &str) -> Result<Project, String> {
    conn.query_row("SELECT * FROM projects WHERE id = ?1", (id,), project_from_row)
        .map_err(|_| "项目不存在".to_string())
}

pub fn project_update_in(conn: &Connection, id: &str, name: &str, description: Option<&str>) -> Result<Project, String> {
    if name.trim().is_empty() {
        return Err("项目名不能为空".to_string());
    }
    let n = conn
        .execute(
            "UPDATE projects SET display_name = ?2, description = ?3, updated_at = ?4 WHERE id = ?1",
            rusqlite::params![id, name.trim(), description, now()],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("项目不存在".to_string());
    }
    project_get_in(conn, id)
}

pub fn project_archive_in(conn: &Connection, id: &str, archived: bool) -> Result<(), String> {
    conn.execute(
        "UPDATE projects SET archived = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![id, archived as i64, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn project_delete_in(conn: &Connection, id: &str) -> Result<(), String> {
    // 级联：field_values → items（含字段值）→ 绑定 → fields → project
    // （显式删除需前端两击确认）
    conn.execute(
        "DELETE FROM project_field_values WHERE item_id IN (SELECT id FROM project_items WHERE project_id = ?1)",
        (id,),
    )
    .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM project_items WHERE project_id = ?1", (id,)).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM project_repos WHERE project_id = ?1", (id,)).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM project_fields WHERE project_id = ?1", (id,)).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM projects WHERE id = ?1", (id,)).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn project_touch_in(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("UPDATE projects SET last_opened_at = ?2 WHERE id = ?1", rusqlite::params![id, now()])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- 字段 ----

pub fn fields_in(conn: &Connection, project_id: &str) -> Result<Vec<ProjectField>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM project_fields WHERE project_id = ?1 ORDER BY position")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map((project_id,), field_from_row).map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// builtin_status 字段（列定义的真源）。
pub fn status_field_in(conn: &Connection, project_id: &str) -> Result<Option<ProjectField>, String> {
    Ok(fields_in(conn, project_id)?
        .into_iter()
        .find(|f| f.kind == "builtin_status"))
}

/// 重写单选字段的 options（改名/调色/排序；item 既有值按 option id 存，
/// 改名无损）。
pub fn field_set_options_in(conn: &Connection, field_id: &str, options: &[FieldOption]) -> Result<(), String> {
    let json = serde_json::to_string(options).map_err(|e| e.to_string())?;
    let n = conn
        .execute("UPDATE project_fields SET options = ?2 WHERE id = ?1", rusqlite::params![field_id, json])
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("字段不存在".to_string());
    }
    Ok(())
}

// ---- 条目 ----

fn item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectItem> {
    Ok(ProjectItem {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        kind: row.get("kind")?,
        repo_id: row.get("repo_id")?,
        number: row.get("number")?,
        draft_title: row.get("draft_title")?,
        draft_body: row.get("draft_body")?,
        rank: row.get("rank")?,
        added_at: row.get("added_at")?,
        repo_label: row.get("repo_label")?,
        ghost: row.get::<_, Option<String>>("joined_repo_id")?.is_none(),
        field_values: std::collections::BTreeMap::new(),
    })
}

const ITEM_SELECT: &str = "SELECT i.*, r.display_name AS repo_label, r.id AS joined_repo_id
 FROM project_items i LEFT JOIN repos r ON r.id = i.repo_id";

fn load_field_values(conn: &Connection, items: &mut [ProjectItem]) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT item_id, field_id, value FROM project_field_values")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for triple in rows {
        let (item_id, field_id, value) = triple.map_err(|e| e.to_string())?;
        if let Some(item) = items.iter_mut().find(|i| i.id == item_id) {
            if let Some(v) = value {
                item.field_values.insert(field_id, v);
            }
        }
    }
    Ok(())
}

pub fn item_list_in(conn: &Connection, project_id: &str) -> Result<Vec<ProjectItem>, String> {
    let sql = format!("{ITEM_SELECT} WHERE i.project_id = ?1 ORDER BY CAST(i.rank AS INTEGER)");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map((project_id,), item_from_row).map_err(|e| e.to_string())?;
    let mut items = rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    load_field_values(conn, &mut items)?;
    Ok(items)
}

pub fn item_get_in(conn: &Connection, item_id: &str) -> Result<ProjectItem, String> {
    let sql = format!("{ITEM_SELECT} WHERE i.id = ?1");
    let mut item = conn
        .query_row(&sql, (item_id,), item_from_row)
        .map_err(|_| "条目不存在".to_string())?;
    load_field_values(conn, std::slice::from_mut(&mut item))?;
    Ok(item)
}

/// 添加条目：draft 直接建；issue/pull 引用必须带 repo_id + number。
/// 初始状态落第一列（builtin_status 首个 option）。
pub fn item_add_in(
    conn: &Connection,
    project_id: &str,
    kind: &str,
    repo_id: Option<&str>,
    number: Option<&str>,
    draft_title: Option<&str>,
    draft_body: Option<&str>,
) -> Result<ProjectItem, String> {
    match kind {
        "draft" if draft_title.map(|t| !t.trim().is_empty()).unwrap_or(false) => {}
        "issue" | "pull" if repo_id.is_some() && number.map(|n| !n.is_empty()).unwrap_or(false) => {}
        _ => return Err("条目参数不完整（draft 需标题；issue/pull 需仓库与编号）".to_string()),
    }
    let id = uuid();
    let rank = next_rank_in(conn, project_id)?;
    conn.execute(
        "INSERT INTO project_items (id, project_id, kind, repo_id, number, draft_title, draft_body, rank, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        rusqlite::params![id, project_id, kind, repo_id, number, draft_title, draft_body, rank, now()],
    )
    .map_err(|e| e.to_string())?;
    if let Some(field) = status_field_in(conn, project_id)? {
        if let Some(first) = field.options.first() {
            set_field_value_in(conn, &id, &field.id, Some(&first.id))?;
        }
    }
    project_touch_in(conn, project_id)?;
    item_get_in(conn, &id)
}

fn next_rank_in(conn: &Connection, project_id: &str) -> Result<String, String> {
    let max: Option<i64> = conn
        .query_row(
            "SELECT MAX(CAST(rank AS INTEGER)) FROM project_items WHERE project_id = ?1",
            (project_id,),
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok((max.unwrap_or(0) + RANK_GAP).to_string())
}

pub fn item_remove_in(conn: &Connection, item_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM project_field_values WHERE item_id = ?1", (item_id,))
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM project_items WHERE id = ?1", (item_id,)).map_err(|e| e.to_string())?;
    Ok(())
}

/// 草稿在位编辑。
pub fn item_update_draft_in(conn: &Connection, item_id: &str, title: &str, body: Option<&str>) -> Result<ProjectItem, String> {
    if title.trim().is_empty() {
        return Err("标题不能为空".to_string());
    }
    let n = conn
        .execute(
            "UPDATE project_items SET draft_title = ?2, draft_body = ?3 WHERE id = ?1 AND kind = 'draft'",
            rusqlite::params![item_id, title.trim(), body],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("草稿不存在".to_string());
    }
    item_get_in(conn, item_id)
}

/// 移动条目：可选换状态列 + 可选插到 prev/next 之间（rank 取中值，
/// 间距耗尽全列重排）。prev/next 传 id，函数内取其 rank。
pub fn item_move_in(
    conn: &Connection,
    item_id: &str,
    status_option_id: Option<&str>,
    prev_id: Option<&str>,
    next_id: Option<&str>,
) -> Result<ProjectItem, String> {
    let item = item_get_in(conn, item_id)?;
    let project_id = item.project_id.clone();

    let neighbor_rank = |id: &str| -> Result<i64, String> {
        conn.query_row("SELECT CAST(rank AS INTEGER) FROM project_items WHERE id = ?1", (id,), |row| row.get(0))
            .map_err(|_| "邻居条目不存在".to_string())
    };
    let prev_rank = prev_id.map(|id| neighbor_rank(id)).transpose()?;
    let next_rank = next_id.map(|id| neighbor_rank(id)).transpose()?;

    let new_rank = match (prev_rank, next_rank) {
        (Some(p), Some(n)) if n - p > 1 => (p + n) / 2,
        (Some(p), None) => p + RANK_GAP,
        (None, Some(n)) if n > RANK_GAP => n - RANK_GAP,
        (None, None) => parse_rank(&item.rank),
        // 间距不足：全列重排后再取中值（罕见路径，保序正确性优先）
        _ => {
            respace_column_in(conn, &project_id, status_option_id.as_deref())?;
            let prev_rank = prev_id.map(|id| neighbor_rank(id)).transpose()?;
            let next_rank = next_id.map(|id| neighbor_rank(id)).transpose()?;
            match (prev_rank, next_rank) {
                (Some(p), Some(n)) => (p + n) / 2,
                (Some(p), None) => p + RANK_GAP,
                (None, Some(n)) => (n.saturating_sub(RANK_GAP)).max(1),
                (None, None) => parse_rank(&item.rank),
            }
        }
    };
    conn.execute("UPDATE project_items SET rank = ?2 WHERE id = ?1", rusqlite::params![item_id, new_rank.to_string()])
        .map_err(|e| e.to_string())?;

    if let Some(option_id) = status_option_id {
        let field = status_field_in(conn, &project_id)?
            .ok_or_else(|| "项目缺少状态字段".to_string())?;
        if !field.options.iter().any(|o| o.id == option_id) {
            return Err("未知的状态选项".to_string());
        }
        set_field_value_in(conn, item_id, &field.id, Some(option_id))?;
    }
    item_get_in(conn, item_id)
}

/// 列内全量重排：按现有序 1024 等距（消除碎片化）。
fn respace_column_in(conn: &Connection, project_id: &str, status_option_id: Option<&str>) -> Result<(), String> {
    let field = status_field_in(conn, project_id)?.ok_or_else(|| "项目缺少状态字段".to_string())?;
    let Some(option_id) = status_option_id else {
        return Ok(()); // 不换列时无从界定列范围，保持原 rank（罕见且无害）
    };
    let sql = format!(
        "{ITEM_SELECT} WHERE i.project_id = ?1 ORDER BY CAST(i.rank AS INTEGER)"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map((project_id,), item_from_row).map_err(|e| e.to_string())?;
    let items = rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    drop(stmt);
    let mut seq = 0i64;
    for item in items {
        let in_column = item
            .field_values
            .get(&field.id)
            .map(|v| v == option_id)
            .unwrap_or(false);
        if in_column {
            seq += RANK_GAP;
            conn.execute("UPDATE project_items SET rank = ?2 WHERE id = ?1", rusqlite::params![item.id, seq.to_string()])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn set_field_value_in(conn: &Connection, item_id: &str, field_id: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(v) => conn
            .execute(
                "INSERT INTO project_field_values (item_id, field_id, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(item_id, field_id) DO UPDATE SET value=excluded.value",
                rusqlite::params![item_id, field_id, v],
            )
            .map_err(|e| e.to_string())?,
        None => conn
            .execute("DELETE FROM project_field_values WHERE item_id = ?1 AND field_id = ?2", rusqlite::params![item_id, field_id])
            .map_err(|e| e.to_string())?,
    };
    Ok(())
}

/// 「关闭→Done」自动化钩子：该仓库该编号的关联条目全部移到 Done 列
/// （按名匹配 "Done"，兜底 builtin_status 末位 option）。
pub fn on_issue_closed_in(conn: &Connection, repo_id: &str, number: &str) -> Result<(), String> {
    let item_ids: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM project_items WHERE kind = 'issue' AND repo_id = ?1 AND number = ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map((repo_id, number), |row| row.get(0)).map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };
    if item_ids.is_empty() {
        return Ok(());
    }
    for item_id in &item_ids {
        let project_id: String = conn
            .query_row("SELECT project_id FROM project_items WHERE id = ?1", (item_id,), |row| row.get(0))
            .map_err(|e| e.to_string())?;
        let Some(field) = status_field_in(conn, &project_id)? else { continue };
        let done = field
            .options
            .iter()
            .find(|o| o.name.eq_ignore_ascii_case("done"))
            .or_else(|| field.options.last());
        if let Some(option) = done {
            set_field_value_in(conn, item_id, &field.id, Some(&option.id))?;
        }
    }
    Ok(())
}

// ---- 项目 ↔ 仓库绑定（仿仓库登记：接入配置标签随 repos 行携带）----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundRepo {
    pub repo_id: String,
    /// 登记显示名（path 尾段或 remote 显示名）。
    pub label: String,
    /// 连接派生来源（github/gitee/gitea）；无连接 = local。
    pub platform: String,
    pub connection_label: Option<String>,
    /// 切换/取数用的 target：本地克隆 = path，仅远端 = remote_url。
    pub target: String,
    /// true = 绑定的登记行已删除（悬挂，跳过展示与导航）。
    pub ghost: bool,
}

pub fn repo_bind_in(conn: &Connection, project_id: &str, repo_id: &str) -> Result<(), String> {
    let exists: Option<String> = conn
        .query_row("SELECT id FROM repos WHERE id = ?1", (repo_id,), |row| row.get(0))
        .ok();
    if exists.is_none() {
        return Err("仓库未登记".to_string());
    }
    conn.execute(
        "INSERT INTO project_repos (project_id, repo_id, position) VALUES (?1, ?2,
            COALESCE((SELECT MAX(position) + 1 FROM project_repos WHERE project_id = ?1), 0))
         ON CONFLICT(project_id, repo_id) DO NOTHING",
        (project_id, repo_id),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn repo_unbind_in(conn: &Connection, project_id: &str, repo_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM project_repos WHERE project_id = ?1 AND repo_id = ?2",
        (project_id, repo_id),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn bound_repos_in(conn: &Connection, project_id: &str) -> Result<Vec<BoundRepo>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT pr.repo_id, r.display_name, r.path, r.remote_url, c.platform, c.label
             FROM project_repos pr
             LEFT JOIN repos r ON r.id = pr.repo_id
             LEFT JOIN connections c ON c.id = r.connection_id
             WHERE pr.project_id = ?1
             ORDER BY pr.position",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((project_id,), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for triple in rows {
        let (repo_id, display_name, path, remote_url, platform, connection_label) =
            triple.map_err(|e| e.to_string())?;
        // 悬挂绑定（登记行已删）：保留 id 供条目对照，标记 ghost
        let (label, target, ghost) = match (&path, &remote_url) {
            (Some(p), _) => (
                display_name.clone().unwrap_or_else(|| {
                    p.split('/').filter(|s| !s.is_empty()).last().unwrap_or(p).to_string()
                }),
                p.clone(),
                false,
            ),
            (None, Some(u)) => {
                (display_name.clone().unwrap_or_else(|| u.clone()), u.clone(), false)
            }
            (None, None) => (repo_id.clone(), String::new(), true),
        };
        out.push(BoundRepo {
            repo_id,
            label,
            platform: platform.unwrap_or_else(|| "local".to_string()),
            connection_label,
            target,
            ghost,
        });
    }
    Ok(out)
}

// ---- 命令层（appdb 先例：命令在各自模块、_in 核心供测试） ----

#[tauri::command]
pub fn project_create(name: String, description: Option<String>) -> Result<Project, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    project_create_in(&conn, &name, description.as_deref())
}

#[tauri::command]
pub fn project_list(include_archived: Option<bool>) -> Result<Vec<Project>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    project_list_in(&conn, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn project_update(id: String, name: String, description: Option<String>) -> Result<Project, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    project_update_in(&conn, &id, &name, description.as_deref())
}

#[tauri::command]
pub fn project_archive(id: String, archived: bool) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    project_archive_in(&conn, &id, archived)
}

#[tauri::command]
pub fn project_delete(id: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    project_delete_in(&conn, &id)
}

#[tauri::command]
pub fn project_fields(project_id: String) -> Result<Vec<ProjectField>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    fields_in(&conn, &project_id)
}

#[tauri::command]
pub fn project_field_set_options(field_id: String, options: Vec<FieldOption>) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    field_set_options_in(&conn, &field_id, &options)
}

#[tauri::command]
pub fn project_item_add(
    project_id: String,
    kind: String,
    repo_id: Option<String>,
    number: Option<String>,
    draft_title: Option<String>,
    draft_body: Option<String>,
) -> Result<ProjectItem, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    item_add_in(&conn, &project_id, &kind, repo_id.as_deref(), number.as_deref(), draft_title.as_deref(), draft_body.as_deref())
}

#[tauri::command]
pub fn project_item_list(project_id: String) -> Result<Vec<ProjectItem>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    project_touch_in(&conn, &project_id)?;
    item_list_in(&conn, &project_id)
}

#[tauri::command]
pub fn project_item_move(
    item_id: String,
    status_option_id: Option<String>,
    prev_id: Option<String>,
    next_id: Option<String>,
) -> Result<ProjectItem, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    item_move_in(&conn, &item_id, status_option_id.as_deref(), prev_id.as_deref(), next_id.as_deref())
}

#[tauri::command]
pub fn project_item_remove(item_id: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    item_remove_in(&conn, &item_id)
}

#[tauri::command]
pub fn project_item_update_draft(item_id: String, title: String, body: Option<String>) -> Result<ProjectItem, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    item_update_draft_in(&conn, &item_id, &title, body.as_deref())
}

#[tauri::command]
pub fn project_field_value_set(item_id: String, field_id: String, value: Option<String>) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    set_field_value_in(&conn, &item_id, &field_id, value.as_deref())
}

#[tauri::command]
pub fn project_repo_bind(project_id: String, repo_id: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    repo_bind_in(&conn, &project_id, &repo_id)
}

#[tauri::command]
pub fn project_repo_unbind(project_id: String, repo_id: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    repo_unbind_in(&conn, &project_id, &repo_id)
}

#[tauri::command]
pub fn project_repo_list(project_id: String) -> Result<Vec<BoundRepo>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    bound_repos_in(&conn, &project_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::appdb::app_migrate(&conn).unwrap();
        conn
    }

    fn seed_repo(conn: &Connection, id: &str) {
        conn.execute(
            "INSERT INTO repos (id, path, display_name, created_at, last_opened_at)
             VALUES (?1, ?2, 'demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            rusqlite::params![id, format!("/tmp/{id}")],
        )
        .unwrap();
    }

    #[test]
    fn create_seeds_status_and_priority() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None).unwrap();
        let fields = fields_in(&conn, &p.id).unwrap();
        assert_eq!(fields.len(), 2);
        let status = fields.iter().find(|f| f.kind == "builtin_status").unwrap();
        assert_eq!(status.options.len(), 3);
        assert_eq!(status.options[0].name, "Todo");
        assert_eq!(fields.iter().find(|f| f.kind == "single_select").unwrap().name, "优先级");
    }

    #[test]
    fn item_add_move_and_rank_order() {
        let conn = mem_db();
        let p = project_create_in(&conn, "board", None).unwrap();
        let status = status_field_in(&conn, &p.id).unwrap().unwrap();
        let a = item_add_in(&conn, &p.id, "draft", None, None, Some("a"), None).unwrap();
        let b = item_add_in(&conn, &p.id, "draft", None, None, Some("b"), None).unwrap();
        let c = item_add_in(&conn, &p.id, "draft", None, None, Some("c"), None).unwrap();
        let (a_id, b_id, c_id) = (a.id.clone(), b.id.clone(), c.id.clone());
        // 初始顺序 a < b < c，且都在第一列
        let items = item_list_in(&conn, &p.id).unwrap();
        assert_eq!(items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(), [a_id.clone(), b_id.clone(), c_id.clone()]);
        assert_eq!(
            items[0].field_values.get(&status.id).map(|v| v.as_str()),
            Some(status.options[0].id.as_str())
        );
        // 把 c 移到 a、b 之间
        item_move_in(&conn, &c.id, None, Some(&a.id), Some(&b.id)).unwrap();
        let items = item_list_in(&conn, &p.id).unwrap();
        assert_eq!(items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(), [a_id.clone(), c_id.clone(), b_id.clone()]);
        // 换列：a 移到 Done
        let done = &status.options[2];
        item_move_in(&conn, &a.id, Some(&done.id), None, None).unwrap();
        let items = item_list_in(&conn, &p.id).unwrap();
        assert_eq!(items.iter().find(|i| i.id == a.id).unwrap().field_values.get(&status.id).map(|v| v.as_str()), Some(done.id.as_str()));
    }

    #[test]
    fn repo_delete_makes_items_ghost() {
        let conn = mem_db();
        seed_repo(&conn, "r1");
        let p = project_create_in(&conn, "board", None).unwrap();
        item_add_in(&conn, &p.id, "issue", Some("r1"), Some("7"), None, None).unwrap();
        assert!(!item_list_in(&conn, &p.id).unwrap()[0].ghost);
        // 删除登记行（appdb 不开 foreign_keys → 悬挂）
        conn.execute("DELETE FROM repos WHERE id = 'r1'", []).unwrap();
        let items = item_list_in(&conn, &p.id).unwrap();
        assert!(items[0].ghost);
        assert!(items[0].repo_label.is_none());
    }

    #[test]
    fn close_issue_moves_item_to_done() {
        let conn = mem_db();
        seed_repo(&conn, "r1");
        let p = project_create_in(&conn, "board", None).unwrap();
        let status = status_field_in(&conn, &p.id).unwrap().unwrap();
        let item = item_add_in(&conn, &p.id, "issue", Some("r1"), Some("7"), None, None).unwrap();
        on_issue_closed_in(&conn, "r1", "7").unwrap();
        let items = item_list_in(&conn, &p.id).unwrap();
        let done_id = status.options.iter().find(|o| o.name == "Done").unwrap().id.clone();
        assert_eq!(items.iter().find(|i| i.id == item.id).unwrap().field_values.get(&status.id).map(|v| v.as_str()), Some(done_id.as_str()));
    }

    #[test]
    fn repo_binding_roundtrip_and_cascade() {
        let conn = mem_db();
        seed_repo(&conn, "r1");
        let p = project_create_in(&conn, "board", None).unwrap();
        // 未登记 id 拒绝
        assert!(repo_bind_in(&conn, &p.id, "nope").is_err());
        repo_bind_in(&conn, &p.id, "r1").unwrap();
        repo_bind_in(&conn, &p.id, "r1").unwrap(); // 幂等
        let bound = bound_repos_in(&conn, &p.id).unwrap();
        assert_eq!(bound.len(), 1);
        assert_eq!(bound[0].repo_id, "r1");
        assert_eq!(bound[0].label, "demo");
        assert!(!bound[0].ghost);
        // 登记删除 → 绑定悬挂标 ghost
        conn.execute("DELETE FROM repos WHERE id = 'r1'", []).unwrap();
        assert!(bound_repos_in(&conn, &p.id).unwrap()[0].ghost);
        // 项目级联删除连带绑定
        project_delete_in(&conn, &p.id).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM project_repos", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
