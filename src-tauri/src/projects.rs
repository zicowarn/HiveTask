//! Projects 本地看板（P4 v1）——应用级真源（app.db 四表，migration 002）。
//!
//! 设计定案（知识库《架构设计-Projects本地看板》）：状态列不是硬编码而是
//! builtin_status 单选字段的 options；列内排序用 rank 分数索引（拖拽取相邻
//! 中值）；item 三形态 issue/pull/draft；仓库删除后条目悬挂 = ghost（读取
//! 时 LEFT JOIN 判定，删除时不级联）；「关闭→Done」是唯一的 v1 自动化。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::appdb::{chrono_like_now, uuid};

// ---- 数据形状 ----

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub group_tag: Option<String>,
    /// 归属接入（切换项目对话框按它分 Tab）；NULL = 本地/未接入。
    pub connection_id: Option<String>,
    /// 平台绑定（导入线上 Projects 时记录；NULL = 纯本地项目）。
    pub platform_kind: Option<String>,
    pub platform_host: Option<String>,
    pub platform_ref: Option<String>,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, serde::Deserialize, Serialize)]
pub struct FieldOption {
    pub id: String,
    pub name: String,
    pub color: String,
    /// 选项说明（GitHub 的 Description：显示在组头与取值面板）；旧数据缺省为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
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
    /// kind=issue|pull 时非空；未关联（未登记 / 登记行已删）= ghost。
    pub repo_id: Option<String>,
    /// 平台引用快照（设备包携带的同一对字段）：导入未命中时留档，登记后据此回填。
    pub origin_url: Option<String>,
    pub origin_type: Option<String>,
    pub number: Option<String>,
    pub draft_title: Option<String>,
    pub draft_body: Option<String>,
    pub rank: String,
    pub added_at: String,
    /// 归档时间戳（NULL = 未归档）。归档 = 移出所有视图但保留条目上下文
    /// （既不是删除，也不是「从项目中移除」）；视图侧统一按它排除。
    pub archived_at: Option<String>,
    /// JOIN 派生：仓库显示名（未关联时 None）。
    pub repo_label: Option<String>,
    /// JOIN 派生：是否「没落到仓库」——非草稿且 repo_id 缺失或指向已删登记行。
    pub ghost: bool,
    /// 字段值 map（field_id → value）。
    pub field_values: std::collections::BTreeMap<String, String>,
    /// 引用实体的只读元数据（跨库读仓库缓存，草稿/未关联/未同步为 None）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<EntityMeta>,
}

/// 引用实体（Issue / PR）的镜像元数据——项目容器只存引用，正文元数据留在
/// 各仓库缓存库里；这里按需补齐，让看板字段面板能列出 GitHub 同名的那些维度
/// （标题 / 开闭 / 作者 / 负责人 / 标签 / 里程碑 / 创建 / 更新时间）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityMeta {
    pub title: String,
    pub state: String,
    pub author: Option<String>,
    pub assignees: Vec<String>,
    pub labels: Vec<String>,
    pub milestone: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
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
        connection_id: row.get("connection_id")?,
        platform_kind: row.get("platform_kind")?,
        platform_host: row.get("platform_host")?,
        platform_ref: row.get("platform_ref")?,
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

pub fn project_create_in(
    conn: &Connection,
    name: &str,
    description: Option<&str>,
    connection_id: Option<&str>,
) -> Result<Project, String> {
    project_create_with_binding_in(conn, name, description, connection_id, None, None, None)
}

/// 创建项目并可同时记录平台绑定（导入线上 Projects 用）。
pub fn project_create_with_binding_in(
    conn: &Connection,
    name: &str,
    description: Option<&str>,
    connection_id: Option<&str>,
    platform_kind: Option<&str>,
    platform_host: Option<&str>,
    platform_ref: Option<&str>,
) -> Result<Project, String> {
    if name.trim().is_empty() {
        return Err("项目名不能为空".to_string());
    }
    if let Some(cid) = connection_id {
        let exists: Option<String> = conn
            .query_row("SELECT id FROM connections WHERE id = ?1", (cid,), |row| row.get(0))
            .ok();
        if exists.is_none() {
            return Err("接入不存在".to_string());
        }
    }
    let id = uuid();
    conn.execute(
        "INSERT INTO projects (id, display_name, description, connection_id, platform_kind, platform_host, platform_ref, created_at, updated_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?1, ?1, ?1)",
        rusqlite::params![
            id,
            name.trim(),
            description,
            connection_id,
            platform_kind,
            platform_host,
            platform_ref
        ],
    )
    .map_err(|e| e.to_string())?;
    seed_fields(conn, &id)?;
    project_get_in(conn, &id)
}

/// 种子字段：builtin_status（Todo/In Progress/Done）+ 优先级单选。
/// 列名可改（field options 重写即可），自动化按名匹配 "Done"。
fn seed_fields(conn: &Connection, project_id: &str) -> Result<(), String> {
    let status = serde_json::to_string(&[
        FieldOption { id: format!("{project_id}-s1"), name: "Todo".into(), color: GRAY.into(), description: None },
        FieldOption { id: format!("{project_id}-s2"), name: "In Progress".into(), color: YELLOW.into(), description: None },
        FieldOption { id: format!("{project_id}-s3"), name: "Done".into(), color: GREEN.into(), description: None },
    ])
    .map_err(|e| e.to_string())?;
    let priority = serde_json::to_string(&[
        FieldOption { id: format!("{project_id}-p1"), name: "P0".into(), color: RED.into(), description: None },
        FieldOption { id: format!("{project_id}-p2"), name: "P1".into(), color: YELLOW.into(), description: None },
        FieldOption { id: format!("{project_id}-p3"), name: "P2".into(), color: GRAY.into(), description: None },
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

/// 项目**内容水位**：导入三选一按 `updated_at` 比较「本机 vs 包」谁更新
/// （《架构设计-导出与导入》§导入），因此**包会带走的本地内容**发生变更时都要过这里。
/// 与 `project_touch_in` 区分：那个记的是「最近打开」，不参与比较。
/// 特意不接的三处：平台镜像行同步（deps/parents_sync_platform_in，包不含镜像）、
/// 平台「关闭→Done」钩子（对端同样从平台得到）、仓库绑定（不进包）。
pub fn project_mark_changed_in(conn: &Connection, project_id: &str) {
    // 水位写失败不该连累用户正在做的编辑：内容已改，水位只是导入建议的依据。
    let _ = conn.execute("UPDATE projects SET updated_at = ?2 WHERE id = ?1", rusqlite::params![project_id, now()]);
}

/// 条目级函数没有 project_id 参数时的水位入口（条目须先存在）。
fn mark_item_changed_in(conn: &Connection, item_id: &str) {
    if let Ok(pid) = conn.query_row("SELECT project_id FROM project_items WHERE id = ?1", (item_id,), |r| {
        r.get::<_, String>(0)
    }) {
        project_mark_changed_in(conn, &pid);
    }
}

/// 字段级函数的水位入口。
fn mark_field_changed_in(conn: &Connection, field_id: &str) {
    if let Ok(pid) = conn.query_row("SELECT project_id FROM project_fields WHERE id = ?1", (field_id,), |r| {
        r.get::<_, String>(0)
    }) {
        project_mark_changed_in(conn, &pid);
    }
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

pub fn field_get_in(conn: &Connection, field_id: &str) -> Result<Option<ProjectField>, String> {
    let mut stmt = conn.prepare("SELECT * FROM project_fields WHERE id = ?1").map_err(|e| e.to_string())?;
    let mut rows = stmt.query_map((field_id,), field_from_row).map_err(|e| e.to_string())?;
    match rows.next() {
        Some(row) => row.map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

/// 分列字段解析：显式 field_id 优先（视图「分列方式」可选任一单选字段），
/// 缺省回落内置状态字段（既有行为）。
fn column_field_in(conn: &Connection, project_id: &str, field_id: Option<&str>) -> Result<ProjectField, String> {
    match field_id {
        Some(fid) => field_get_in(conn, fid)?.ok_or_else(|| "未知字段".to_string()),
        None => status_field_in(conn, project_id)?.ok_or_else(|| "项目缺少状态字段".to_string()),
    }
}

/// 自建字段类型（对齐 GitHub 的最小集；值一律以文本落库，类型只影响渲染与校验）。
pub const CUSTOM_FIELD_KINDS: [&str; 4] = ["single_select", "text", "number", "date"];

/// 单选选项默认配色（按声明顺序轮转）。
const GRAY: &str = "#59636e";
const YELLOW: &str = "#9a6700";
const GREEN: &str = "#1a7f37";
const RED: &str = "#d1242f";

/// 选项可选色（GitHub 的八色选项调色板，取自平台页面）。
const OPTION_PALETTE: [&str; 8] = [GRAY, "#0969da", GREEN, YELLOW, "#bc4c00", RED, "#bf3989", "#8250df"];

/// 新建字段：position 追加到末尾；单选至少给一个选项名（id 与颜色由后端配）。
pub fn field_create_in(
    conn: &Connection,
    project_id: &str,
    name: &str,
    kind: &str,
    option_names: &[String],
) -> Result<ProjectField, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("字段名不能为空".to_string());
    }
    if !CUSTOM_FIELD_KINDS.contains(&kind) {
        return Err("不支持的字段类型".to_string());
    }
    let existing = fields_in(conn, project_id)?;
    if existing.iter().any(|f| f.name == name) {
        return Err("字段名已存在".to_string());
    }
    let names: Vec<String> = option_names
        .iter()
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect();
    if kind == "single_select" && names.is_empty() {
        return Err("单选字段至少需要一个选项".to_string());
    }
    let position = existing.iter().map(|f| f.position).max().map(|m| m + 1).unwrap_or(0);
    let id = format!("{}-{}", project_id, crate::appdb::uuid());
    let options: Vec<FieldOption> = if kind == "single_select" {
        names
            .iter()
            .enumerate()
            .map(|(i, n)| FieldOption {
                id: format!("{id}-o{i}"),
                name: n.clone(),
                color: OPTION_PALETTE[i % OPTION_PALETTE.len()].to_string(),
                description: None,
            })
            .collect()
    } else {
        Vec::new()
    };
    let json = serde_json::to_string(&options).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO project_fields (id, project_id, kind, name, options, position)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![id, project_id, kind, name, json, position],
    )
    .map_err(|e| e.to_string())?;
    project_mark_changed_in(conn, project_id);
    field_get_in(conn, &id)?.ok_or_else(|| "字段创建失败".to_string())
}

/// 追加一个选项（新建列 / 新建泳道段）：id 与位置由后端定，颜色取调色板。
pub fn field_option_add_in(
    conn: &Connection,
    field_id: &str,
    name: &str,
    color: Option<&str>,
) -> Result<ProjectField, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    let field = field_get_in(conn, field_id)?.ok_or_else(|| "未知字段".to_string())?;
    if field.options.iter().any(|o| o.name == name) {
        return Err("同名选项已存在".to_string());
    }
    let next = field.options.len();
    let mut options = field.options.clone();
    options.push(FieldOption {
        id: format!("{}-o{}", field.id, crate::appdb::uuid()),
        name: name.to_string(),
        color: color
            .map(|c| c.to_string())
            .unwrap_or_else(|| OPTION_PALETTE[next % OPTION_PALETTE.len()].to_string()),
        description: None,
    });
    field_set_options_in(conn, &field.id, &options)?;
    field_get_in(conn, field_id)?.ok_or_else(|| "字段读取失败".to_string())
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
    mark_field_changed_in(conn, field_id);
    Ok(())
}

// ---- 条目 ----

fn item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectItem> {
    let repo_id: Option<String> = row.get("repo_id")?;
    let kind: String = row.get("kind")?;
    // 「没落到仓库」= 非草稿 且 JOIN 落空。两种来路都算：条目引用的登记行被删
    // （悬挂），或设备包导入时未命中本机登记表（repo_id 为 NULL，origin 留档待回填）。
    // 草稿天然没有仓库，不属此列——早先只看 JOIN 会把所有草稿误标。
    let ghost = kind != "draft" && row.get::<_, Option<String>>("joined_repo_id")?.is_none();
    Ok(ProjectItem {
        id: row.get("id")?,
        project_id: row.get("project_id")?,
        kind,
        repo_id,
        origin_url: row.get("origin_url")?,
        origin_type: row.get("origin_type")?,
        number: row.get("number")?,
        draft_title: row.get("draft_title")?,
        draft_body: row.get("draft_body")?,
        rank: row.get("rank")?,
        added_at: row.get("added_at")?,
        archived_at: row.get("archived_at")?,
        repo_label: row.get("repo_label")?,
        ghost,
        field_values: std::collections::BTreeMap::new(),
        entity: None,
    })
}

const ITEM_SELECT: &str = "SELECT i.*, r.display_name AS repo_label, r.id AS joined_repo_id
 FROM project_items i LEFT JOIN repos r ON r.id = i.repo_id";

/// 注册仓库的仓库根：本地克隆 → 工作区本身；仅远端登记 →
/// app data 的 repos-cache/<owner>/<repo>（与 lib.rs repo_root_of 同口径；
/// 索引库实际在 storage::index_db_path 指向的 app data 里）。
fn repo_root_for_repo(conn: &Connection, repo_id: &str) -> Option<std::path::PathBuf> {
    let (path, remote_url): (Option<String>, Option<String>) = conn
        .query_row("SELECT path, remote_url FROM repos WHERE id = ?1", (repo_id,), |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .ok()?;
    if let Some(dir) = path.filter(|p| !p.is_empty()) {
        return Some(std::path::PathBuf::from(dir));
    }
    let url = remote_url.filter(|u| !u.is_empty())?;
    let repo = crate::source::resolve_target(&url).ok()?;
    crate::appdb::remote_cache_dir(&repo.owner, &repo.repo)
}

/// 只读打开仓库缓存库；不存在（从未同步）即返回 None，不因缺缓存报错。
fn open_cache_readonly(dir: &std::path::Path) -> Option<Connection> {
    let Ok(db) = crate::storage::index_db_path(dir) else { return None };
    if !db.exists() {
        return None;
    }
    Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

fn json_strings(raw: Option<String>) -> Vec<String> {
    raw.and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok()).unwrap_or_default()
}

/// 按 kind 从缓存库批量取实体元数据（number → meta）；缺表/缺列按空处理。
fn entity_meta_map(
    cache: &Connection,
    kind: &str,
    numbers: &[String],
) -> std::collections::HashMap<String, EntityMeta> {
    let mut out = std::collections::HashMap::new();
    if numbers.is_empty() {
        return out;
    }
    // pulls 表没有 milestone 列（对齐 GitHub：PR 不挂仓库里程碑）
    let (table, milestone_col) = if kind == "pull" { ("pulls", "NULL") } else { ("issues", "milestone") };
    let placeholders = vec!["?"; numbers.len()].join(",");
    let sql = format!(
        "SELECT number, title, state, author, assignees, labels, {milestone_col}, created_at, updated_at
         FROM {table} WHERE number IN ({placeholders})"
    );
    let Ok(mut stmt) = cache.prepare(&sql) else {
        return out;
    };
    let params: Vec<&dyn rusqlite::ToSql> = numbers.iter().map(|n| n as &dyn rusqlite::ToSql).collect();
    let Ok(rows) = stmt.query_map(params.as_slice(), |row| {
        Ok((
            row.get::<_, String>(0)?,
            EntityMeta {
                title: row.get(1)?,
                state: row.get(2)?,
                author: row.get(3)?,
                assignees: json_strings(row.get(4)?),
                labels: json_strings(row.get(5)?),
                milestone: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            },
        ))
    }) else {
        return out;
    };
    for row in rows.flatten() {
        out.insert(row.0, row.1);
    }
    out
}

/// 给条目补齐引用实体元数据（读不到就留 None）。项目容器在 app.db、实体元数据
/// 在各仓库缓存库，故按 repo 分组、每个仓库只开一次库。
fn enrich_items(conn: &Connection, items: &mut [ProjectItem]) {
    let mut by_repo: std::collections::BTreeMap<String, Vec<(String, usize)>> =
        std::collections::BTreeMap::new();
    for (idx, item) in items.iter().enumerate() {
        if item.kind == "draft" {
            continue;
        }
        if let (Some(repo_id), Some(number)) = (item.repo_id.clone(), item.number.clone()) {
            by_repo.entry(repo_id).or_default().push((number, idx));
        }
    }
    for (repo_id, refs) in by_repo {
        let Some(dir) = repo_root_for_repo(conn, &repo_id) else { continue };
        let Some(cache) = open_cache_readonly(&dir) else { continue };
        for kind in ["issue", "pull"] {
            let refs_of_kind: Vec<(String, usize)> = refs
                .iter()
                .filter(|(_, idx)| items[*idx].kind == kind)
                .cloned()
                .collect();
            let numbers: Vec<String> = refs_of_kind.iter().map(|(n, _)| n.clone()).collect();
            let meta = entity_meta_map(&cache, kind, &numbers);
            for (number, idx) in refs_of_kind {
                items[idx].entity = meta.get(&number).cloned();
            }
        }
    }
}

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
    enrich_items(conn, &mut items);
    Ok(items)
}

pub fn item_get_in(conn: &Connection, item_id: &str) -> Result<ProjectItem, String> {
    let sql = format!("{ITEM_SELECT} WHERE i.id = ?1");
    let mut item = conn
        .query_row(&sql, (item_id,), item_from_row)
        .map_err(|_| "条目不存在".to_string())?;
    load_field_values(conn, std::slice::from_mut(&mut item))?;
    enrich_items(conn, std::slice::from_mut(&mut item));
    Ok(item)
}

/// 添加条目：draft 直接建；issue/pull 引用必须带 repo_id + number。
/// 初始状态落第一列（builtin_status 首个 option）。
/// 引用条目顺带记**平台引用快照**（origin_url / origin_type）——设备包导出、
/// 登记行删除后的回填都靠它（见 relink_origin_in）。
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
    let (origin_url, origin_type) = repo_id.map(|rid| repo_origin_of(conn, rid)).unwrap_or((None, None));
    conn.execute(
        "INSERT INTO project_items (id, project_id, kind, repo_id, number, draft_title, draft_body, rank, added_at, origin_url, origin_type)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![id, project_id, kind, repo_id, number, draft_title, draft_body, rank, now(), origin_url, origin_type],
    )
    .map_err(|e| e.to_string())?;
    if let Some(field) = status_field_in(conn, project_id)? {
        if let Some(first) = field.options.first() {
            set_field_value_in(conn, &id, &field.id, Some(&first.id))?;
        }
    }
    project_touch_in(conn, project_id)?;
    project_mark_changed_in(conn, project_id);
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

/// 登记的 remote_url / platform（条目记引用快照用）。仓库可仅有本地路径 →
/// remote_url 为空（本地库条目没有平台引用，"origin 快照"就是空）。
fn repo_origin_of(conn: &Connection, repo_id: &str) -> (Option<String>, Option<String>) {
    conn.query_row(
        "SELECT r.remote_url, c.platform FROM repos r LEFT JOIN connections c ON c.id = r.connection_id WHERE r.id = ?1",
        (repo_id,),
        |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
    )
    .unwrap_or((None, None))
}

/// URL 归一（只用于**匹配**，不落库）：host 小写 + owner/repo 小写、去 .git。
/// 两侧都过这一道，才能让 `https://GitHub.com/O/R.git` 与 `https://github.com/o/r` 相等。
/// 导入时的 origin→repo 解析与 `relink_origin_in` 共用它，避免两把尺子量出两种结果。
pub fn origin_key(url: &str) -> Option<String> {
    crate::source::split_host_slug(url).map(|(host, slug)| format!("{host}/{}", slug.to_lowercase()))
}

/// 回填「未关联」条目：按 origin_url 把它们挂回本机登记表，返回成功挂接的条数。
///
/// 使用时机 = 用户把设备包引用的仓库登记/打开之后（导入当时未命中才留的坑）。
/// 幂等：已落到仓库的条目不参与；找不到匹配仓库的条目原样留着（origin 还在，
/// 下次登记后再回填即可）。写入安全（不删任何行），故无快照、无事务要求，
/// 但按项目一次性更新仍走单事务，避免半途状态。
pub fn relink_origin_in(conn: &Connection, project_id: &str) -> Result<usize, String> {
    let dangling: Vec<(String, String)> = conn
        .prepare(
            "SELECT i.id, i.origin_url FROM project_items i
             WHERE i.project_id = ?1 AND i.kind != 'draft' AND i.origin_url IS NOT NULL
               AND (i.repo_id IS NULL OR i.repo_id NOT IN (SELECT id FROM repos))",
        )
        .map_err(|e| e.to_string())?
        .query_map((project_id,), |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|x| x.ok())
        .collect();
    if dangling.is_empty() {
        return Ok(0);
    }
    let repos: Vec<(String, Option<String>)> = conn
        .prepare("SELECT id, remote_url FROM repos")
        .map_err(|e| e.to_string())?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|x| x.ok())
        .collect();
    let mut n = 0usize;
    conn.execute("BEGIN", ()).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        for (item_id, origin) in &dangling {
            let Some(want) = origin_key(origin) else { continue };
            let hit = repos
                .iter()
                .find(|(_, url)| url.as_deref().and_then(origin_key).as_deref() == Some(want.as_str()));
            if let Some((repo_id, _)) = hit {
                conn.execute("UPDATE project_items SET repo_id = ?2 WHERE id = ?1", (item_id, repo_id))
                    .map_err(|e| e.to_string())?;
                n += 1;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute("COMMIT", ()).map(|_| ()).map_err(|e| e.to_string())?;
            if n > 0 {
                project_mark_changed_in(conn, project_id);
            }
            Ok(n)
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", ());
            Err(e)
        }
    }
}

pub fn item_remove_in(conn: &Connection, item_id: &str) -> Result<(), String> {
    mark_item_changed_in(conn, item_id); // 须在删行前查归属项目
    conn.execute("DELETE FROM project_field_values WHERE item_id = ?1", (item_id,))
        .map_err(|e| e.to_string())?;
    // 依赖与父子边双向级联（甘特计划面 §3：条目删除，两端都清）
    conn.execute("DELETE FROM project_item_deps WHERE item_id = ?1 OR depends_on = ?1", (item_id,))
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM project_item_parents WHERE item_id = ?1 OR parent_id = ?1", (item_id,))
        .map_err(|e| e.to_string())?;
    // 资源分配（§5-bis）：条目被移除 → 其分配一并清理
    crate::resources::item_resources_cascade_in(conn, item_id)?;
    conn.execute("DELETE FROM project_items WHERE id = ?1", (item_id,)).map_err(|e| e.to_string())?;
    Ok(())
}

/// 条目归档 / 还原（对齐 GitHub Projects：Archive 把条目移出所有视图、保留上下文）。
/// 归档写时间戳、还原置 NULL，幂等；不删行、不碰 Issue/仓库实体、不写 journal
/// ——那是「从项目中移除」的语义（item_remove_in）。
pub fn item_archive_in(conn: &Connection, item_id: &str, archived: bool) -> Result<(), String> {
    let exists: Option<String> = conn
        .query_row("SELECT id FROM project_items WHERE id = ?1", (item_id,), |row| row.get(0))
        .ok();
    if exists.is_none() {
        return Err("条目不存在".to_string());
    }
    let stamp = if archived { Some(now()) } else { None };
    conn.execute(
        "UPDATE project_items SET archived_at = ?2 WHERE id = ?1",
        rusqlite::params![item_id, stamp],
    )
    .map_err(|e| e.to_string())?;
    mark_item_changed_in(conn, item_id);
    Ok(())
}

// ---- 甘特依赖边（容器真源泳道；《架构设计-甘特计划面》§3–4）----

/// 一条依赖边：item_id 依赖 depends_on（FS 语义）。G3-a 只写容器真源
/// （origin NULL）；平台镜像行待 G3-b 写穿透落地时由 G1 刷新整组重写。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDep {
    pub item_id: String,
    pub depends_on: String,
    pub origin: Option<String>,
}

/// 镜像同步的输入边（前端 → Rust）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDepInput {
    pub item_id: String,
    pub depends_on: String,
}

pub fn deps_in(conn: &Connection, project_id: &str) -> Result<Vec<ItemDep>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT d.item_id, d.depends_on, d.origin
             FROM project_item_deps d
             JOIN project_items i ON i.id = d.item_id
             WHERE i.project_id = ?1
             ORDER BY d.item_id, d.depends_on",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((project_id,), |row| {
            Ok(ItemDep {
                item_id: row.get(0)?,
                depends_on: row.get(1)?,
                origin: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 依赖是否成环：从 depends_on 沿「依赖谁」方向走，若回到 item_id 则成环
/// （A→B、B→A 是最短环；合并图语义与前端 wouldCreateCycle 同构）。
fn dep_creates_cycle(conn: &Connection, project_id: &str, item_id: &str, depends_on: &str) -> bool {
    let Ok(deps) = deps_in(conn, project_id) else { return true }; // 读不出图 = 拒写（保守）
    let mut graph = std::collections::HashMap::<&str, Vec<&str>>::new();
    for d in &deps {
        graph.entry(d.item_id.as_str()).or_default().push(d.depends_on.as_str());
    }
    let mut stack = vec![depends_on];
    let mut seen = std::collections::HashSet::new();
    while let Some(cur) = stack.pop() {
        if cur == item_id {
            return true;
        }
        if !seen.insert(cur) {
            continue;
        }
        if let Some(nexts) = graph.get(cur) {
            stack.extend(nexts.iter().copied());
        }
    }
    false
}

/// 新增依赖边（容器真源）。校验：同项目、非自指、不成环；幂等（已存在即成功）。
pub fn dep_add_in(conn: &Connection, project_id: &str, item_id: &str, depends_on: &str) -> Result<(), String> {
    if item_id == depends_on {
        return Err("不能依赖自己".to_string());
    }
    for id in [item_id, depends_on] {
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM project_items WHERE id = ?1 AND project_id = ?2", (id, project_id), |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("条目不在该项目内".to_string());
        }
    }
    if dep_creates_cycle(conn, project_id, item_id, depends_on) {
        return Err("会形成循环依赖".to_string());
    }
    conn.execute(
        "INSERT OR IGNORE INTO project_item_deps (item_id, depends_on, origin) VALUES (?1, ?2, NULL)",
        (item_id, depends_on),
    )
    .map_err(|e| e.to_string())?;
    project_mark_changed_in(conn, project_id);
    Ok(())
}

/// 删除依赖边；只删容器真源（origin IS NULL）——平台镜像行的删除属 G3-b
/// 写穿透，此口子不得误删镜像（镜像由 G1 刷新整组重写管理）。
pub fn dep_remove_in(conn: &Connection, project_id: &str, item_id: &str, depends_on: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "DELETE FROM project_item_deps
             WHERE item_id = ?1 AND depends_on = ?2 AND origin IS NULL
               AND item_id IN (SELECT id FROM project_items WHERE project_id = ?3)",
            (item_id, depends_on, project_id),
        )
        .map_err(|e| e.to_string())?;
    if n > 0 {
        project_mark_changed_in(conn, project_id);
    }
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
    mark_item_changed_in(conn, item_id);
    item_get_in(conn, item_id)
}

/// 移动条目：可选换状态列 + 可选插到 prev/next 之间（rank 取中值，
/// 间距耗尽全列重排）。prev/next 传 id，函数内取其 rank。
pub fn item_move_in(
    conn: &Connection,
    item_id: &str,
    field_id: Option<&str>,
    option_id: Option<&str>,
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
            respace_column_in(conn, &project_id, field_id, option_id)?;
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

    if let Some(opt_id) = option_id {
        let field = column_field_in(conn, &project_id, field_id)?;
        if !field.options.iter().any(|o| o.id == opt_id) {
            return Err("未知的列选项".to_string());
        }
        set_field_value_in(conn, item_id, &field.id, Some(opt_id))?;
    }
    project_mark_changed_in(conn, &project_id);
    item_get_in(conn, item_id)
}

/// 列内全量重排：按现有序 1024 等距（消除碎片化）。
fn respace_column_in(
    conn: &Connection,
    project_id: &str,
    field_id: Option<&str>,
    option_id: Option<&str>,
) -> Result<(), String> {
    let field = column_field_in(conn, project_id, field_id)?;
    let Some(option_id) = option_id else {
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
    mark_item_changed_in(conn, item_id);
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
pub fn project_import_remote(
    name: String,
    connection_id: Option<String>,
    platform_kind: String,
    platform_host: String,
    platform_ref: String,
) -> Result<Project, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    project_create_with_binding_in(
        &conn,
        &name,
        None,
        connection_id.as_deref(),
        Some(&platform_kind),
        Some(&platform_host),
        Some(&platform_ref),
    )
}

#[tauri::command]
pub fn project_create(
    name: String,
    description: Option<String>,
    connection_id: Option<String>,
) -> Result<Project, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    project_create_in(&conn, &name, description.as_deref(), connection_id.as_deref())
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
    field_id: Option<String>,
    option_id: Option<String>,
    prev_id: Option<String>,
    next_id: Option<String>,
) -> Result<ProjectItem, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    item_move_in(
        &conn,
        &item_id,
        field_id.as_deref(),
        option_id.as_deref(),
        prev_id.as_deref(),
        next_id.as_deref(),
    )
}

#[tauri::command]
pub fn project_item_remove(item_id: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    item_remove_in(&conn, &item_id)
}

/// 条目归档 / 还原（archived=true 归档，false 还原）。视图侧默认排除归档项，
/// 回收走「已归档条目」Editor。
#[tauri::command]
pub fn project_item_archive(item_id: String, archived: bool) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    item_archive_in(&conn, &item_id, archived)
}

#[tauri::command]
pub fn project_item_update_draft(item_id: String, title: String, body: Option<String>) -> Result<ProjectItem, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    item_update_draft_in(&conn, &item_id, &title, body.as_deref())
}

#[tauri::command]
pub fn project_field_create(
    project_id: String,
    name: String,
    kind: String,
    option_names: Vec<String>,
) -> Result<ProjectField, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    field_create_in(&conn, &project_id, &name, &kind, &option_names)
}

#[tauri::command]
pub fn project_field_option_add(
    field_id: String,
    name: String,
    color: Option<String>,
) -> Result<ProjectField, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    field_option_add_in(&conn, &field_id, &name, color.as_deref())
}

#[tauri::command]
pub fn project_field_value_set(item_id: String, field_id: String, value: Option<String>) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    set_field_value_in(&conn, &item_id, &field_id, value.as_deref())
}

/// 采集/刷新当天快照（同日覆盖）；项目数据装载后调用（幂等）。
#[tauri::command]
pub fn project_snapshot_take(project_id: String) -> Result<ProjectSnapshot, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    snapshot_take_in(&conn, &project_id)
}

/// 最近 `days` 天的快照（升序）。
#[tauri::command]
pub fn project_snapshot_list(project_id: String, days: i64) -> Result<Vec<ProjectSnapshot>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    snapshot_list_in(&conn, &project_id, days)
}

/// 回填「未关联」条目（按 origin_url 挂回登记表）；返回挂接条数。
/// 用户把设备包引用的仓库登记/打开之后调用（幂等，找不到匹配就原样留着）。
#[tauri::command]
pub fn project_relink_origin(project_id: String) -> Result<usize, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    relink_origin_in(&conn, &project_id)
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

/// 父子里程碑边（结构扩展泳道，§3）：item_id 的上级 = parent_id。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemParent {
    pub item_id: String,
    pub parent_id: String,
    pub origin: Option<String>,
}

pub fn parents_in(conn: &Connection, project_id: &str) -> Result<Vec<ItemParent>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.item_id, p.parent_id, p.origin
             FROM project_item_parents p
             JOIN project_items i ON i.id = p.item_id
             WHERE i.project_id = ?1
             ORDER BY p.item_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((project_id,), |row| {
            Ok(ItemParent {
                item_id: row.get(0)?,
                parent_id: row.get(1)?,
                origin: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 设置上级（容器真源）。校验：同项目、非自指、**不成环**（沿父链上溯）。
/// 一个条目至多一个上级（PRIMARY KEY 覆盖）。
pub fn parent_set_in(conn: &Connection, project_id: &str, item_id: &str, parent_id: &str) -> Result<(), String> {
    if item_id == parent_id {
        return Err("不能把自己设为上级".to_string());
    }
    for id in [item_id, parent_id] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM project_items WHERE id = ?1 AND project_id = ?2",
                (id, project_id),
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("条目不在该项目内".to_string());
        }
    }
    // 环检测：从 parent_id 沿父链上溯，遇到 item_id 即成环
    let all = parents_in(conn, project_id)?;
    let mut cursor = Some(parent_id.to_string());
    let mut seen = std::collections::HashSet::new();
    while let Some(cur) = cursor {
        if cur == item_id {
            return Err("会形成循环的层级".to_string());
        }
        if !seen.insert(cur.clone()) {
            break; // 既有链本身有环（脏数据）：停手，不放大
        }
        cursor = all.iter().find(|p| p.item_id == cur).map(|p| p.parent_id.clone());
    }
    conn.execute(
        "INSERT INTO project_item_parents (item_id, parent_id, origin) VALUES (?1, ?2, NULL)
         ON CONFLICT(item_id) DO UPDATE SET parent_id = excluded.parent_id, origin = NULL",
        (item_id, parent_id),
    )
    .map_err(|e| e.to_string())?;
    project_mark_changed_in(conn, project_id);
    Ok(())
}

/// 清除上级；只动容器真源行（平台镜像由同步管理）。
pub fn parent_clear_in(conn: &Connection, project_id: &str, item_id: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "DELETE FROM project_item_parents
             WHERE item_id = ?1 AND origin IS NULL
               AND item_id IN (SELECT id FROM project_items WHERE project_id = ?2)",
            (item_id, project_id),
        )
        .map_err(|e| e.to_string())?;
    if n > 0 {
        project_mark_changed_in(conn, project_id);
    }
    Ok(())
}

// ---- 项目分析：每日计数快照（《架构设计-Projects本地看板》Q9）----

/// 一天的计数快照（渲染所需最小面）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    /// YYYY-MM-DD（本地日）。
    pub day: String,
    pub total: i64,
    /// 状态选项 id → 计数（渲染键）。
    pub status: std::collections::BTreeMap<String, i64>,
    /// 状态选项 id → 当时的名字（选项后来被改名/删除时历史仍可读）。
    pub labels: std::collections::BTreeMap<String, String>,
}

/// `#`（无状态值）与草稿同列在图表里的兜底标签键。
const SNAPSHOT_NO_STATUS: &str = "__none__";

/// 采集/刷新**当天**快照（幂等：同日覆盖——一天内多开几次记的是当天最后状态）。
pub fn snapshot_take_in(conn: &Connection, project_id: &str) -> Result<ProjectSnapshot, String> {
    let mut status: std::collections::BTreeMap<String, i64> = Default::default();
    let mut labels: std::collections::BTreeMap<String, String> = Default::default();
    let status_field = status_field_in(conn, project_id)?;
    if let Some(field) = &status_field {
        for o in &field.options {
            labels.insert(o.id.clone(), o.name.clone());
        }
    }
    // 直接按状态字段值分组计数（不 enrich 条目——分析只要计数，省掉跨库读缓存）
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(v.value, ?2), COUNT(*) FROM project_items i
             LEFT JOIN project_field_values v ON v.item_id = i.id AND v.field_id = ?3
             WHERE i.project_id = ?1 GROUP BY 1",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, i64)> = stmt
        .query_map(
            rusqlite::params![project_id, SNAPSHOT_NO_STATUS, status_field.as_ref().map(|f| f.id.clone())],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?
        .filter_map(|x| x.ok())
        .collect();
    let mut total = 0i64;
    for (key, n) in rows {
        total += n;
        status.insert(key, n);
    }
    let today = crate::resources::now_iso();
    let day = today.get(..10).unwrap_or(&today).to_string();
    let snap = ProjectSnapshot { day: day.clone(), total, status, labels };
    let counts = serde_json::to_string(&serde_json::json!({
        "total": snap.total, "status": snap.status, "labels": snap.labels
    }))
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO project_snapshots (project_id, day, counts, taken_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(project_id, day) DO UPDATE SET counts = excluded.counts, taken_at = excluded.taken_at",
        rusqlite::params![project_id, day, counts, today],
    )
    .map_err(|e| e.to_string())?;
    Ok(snap)
}

/// 读取最近 `days` 天快照（升序，供燃起图直接铺）。
pub fn snapshot_list_in(conn: &Connection, project_id: &str, days: i64) -> Result<Vec<ProjectSnapshot>, String> {
    let days = days.clamp(1, 3650);
    let mut stmt = conn
        .prepare(
            "SELECT day, counts FROM project_snapshots WHERE project_id = ?1
             ORDER BY day DESC LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = stmt
        .query_map((project_id, days), |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|x| x.ok())
        .collect();
    let mut out: Vec<ProjectSnapshot> = Vec::with_capacity(rows.len());
    for (day, counts) in rows {
        let v: serde_json::Value = serde_json::from_str(&counts).unwrap_or(serde_json::Value::Null);
        let map_of = |key: &str| -> std::collections::BTreeMap<String, i64> {
            v.get(key)
                .and_then(|x| x.as_object())
                .map(|o| o.iter().map(|(k, val)| (k.clone(), val.as_i64().unwrap_or(0))).collect())
                .unwrap_or_default()
        };
        out.push(ProjectSnapshot {
            day,
            total: v.get("total").and_then(|x| x.as_i64()).unwrap_or(0),
            status: map_of("status"),
            labels: v
                .get("labels")
                .and_then(|x| x.as_object())
                .map(|o| {
                    o.iter()
                        .map(|(k, val)| (k.clone(), val.as_str().unwrap_or_default().to_string()))
                        .collect()
                })
                .unwrap_or_default(),
        });
    }
    out.reverse(); // 升序（图表左→右 = 早→近）
    Ok(out)
}

/// 平台镜像整组同步（平台 sub-issues → 本地镜像行；真源行不触碰）。
pub fn parents_sync_platform_in(
    conn: &Connection,
    project_id: &str,
    origin: &str,
    edges: &[(String, String)],
) -> Result<(), String> {
    conn.execute("BEGIN", ()).map_err(|e| e.to_string())?;
    let result = (|| {
        conn.execute(
            "DELETE FROM project_item_parents
             WHERE origin = ?1
               AND item_id IN (SELECT id FROM project_items WHERE project_id = ?2)",
            (origin, project_id),
        )
        .map_err(|e| e.to_string())?;
        for (item_id, parent_id) in edges {
            // 真源行优先：已有 origin NULL 的条目不插镜像
            conn.execute(
                "INSERT OR IGNORE INTO project_item_parents (item_id, parent_id, origin)
                 VALUES (?1, ?2, ?3)",
                (item_id, parent_id, origin),
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute("COMMIT", ()).map(|_| ()).map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute("ROLLBACK", ());
            Err(e)
        }
    }
}

#[tauri::command]
pub fn project_parent_list(project_id: String) -> Result<Vec<ItemParent>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    parents_in(&conn, &project_id)
}

#[tauri::command]
pub fn project_parent_set(project_id: String, item_id: String, parent_id: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    parent_set_in(&conn, &project_id, &item_id, &parent_id)
}

#[tauri::command]
pub fn project_parent_clear(project_id: String, item_id: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    parent_clear_in(&conn, &project_id, &item_id)
}

#[tauri::command]
pub fn project_parent_sync_platform(
    project_id: String,
    origin: String,
    edges: Vec<ItemDepInput>,
) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    let pairs: Vec<(String, String)> = edges.into_iter().map(|e| (e.item_id, e.depends_on)).collect();
    parents_sync_platform_in(&conn, &project_id, &origin, &pairs)
}

#[tauri::command]
pub fn project_dep_list(project_id: String) -> Result<Vec<ItemDep>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    deps_in(&conn, &project_id)
}

#[tauri::command]
pub fn project_dep_add(project_id: String, item_id: String, depends_on: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    dep_add_in(&conn, &project_id, &item_id, &depends_on)
}

#[tauri::command]
pub fn project_dep_remove(project_id: String, item_id: String, depends_on: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    dep_remove_in(&conn, &project_id, &item_id, &depends_on)
}

/// 平台镜像行整组同步（甘特计划面 §4：镜像持久化，G3-b）。
/// 事务内：先清本项目 + 该 origin 的旧镜像行，再插入新边（INSERT OR IGNORE
/// —— 同键若已有容器真源行则保留真源行）。容器真源行（origin NULL）永不触碰。
pub fn deps_sync_platform_in(
    conn: &Connection,
    project_id: &str,
    origin: &str,
    edges: &[(String, String)],
) -> Result<(), String> {
    conn.execute("BEGIN", ()).map_err(|e| e.to_string())?;
    let result = (|| {
        conn.execute(
            "DELETE FROM project_item_deps
             WHERE origin = ?1
               AND item_id IN (SELECT id FROM project_items WHERE project_id = ?2)",
            (origin, project_id),
        )
        .map_err(|e| e.to_string())?;
        for (item_id, depends_on) in edges {
            conn.execute(
                "INSERT OR IGNORE INTO project_item_deps (item_id, depends_on, origin)
                 VALUES (?1, ?2, ?3)",
                (item_id, depends_on, origin),
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    match result {
        Ok(()) => conn.execute("COMMIT", ()).map(|_| ()).map_err(|e| e.to_string()),
        Err(e) => {
            let _ = conn.execute("ROLLBACK", ());
            Err(e)
        }
    }
}

#[tauri::command]
pub fn project_dep_sync_platform(
    project_id: String,
    origin: String,
    edges: Vec<ItemDepInput>,
) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    let pairs: Vec<(String, String)> = edges.into_iter().map(|e| (e.item_id, e.depends_on)).collect();
    deps_sync_platform_in(&conn, &project_id, &origin, &pairs)
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

    /// 每日快照：按状态字段分组计数、同日覆盖（一天内多次采集记最后状态）、
    /// 草稿/无状态值归并到 `__none__`、读取按天升序。
    #[test]
    fn snapshot_counts_by_status_and_is_idempotent_per_day() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        let status = status_field_in(&conn, &p.id).unwrap().unwrap();
        let (opt0, opt1) = (status.options[0].id.clone(), status.options[1].id.clone());

        let a = item_add_in(&conn, &p.id, "draft", None, None, Some("卡一"), None).unwrap();
        let b = item_add_in(&conn, &p.id, "draft", None, None, Some("卡二"), None).unwrap();
        item_add_in(&conn, &p.id, "draft", None, None, Some("卡三"), None).unwrap();
        // a 保持首列（item_add_in 落的），b 移到第二列
        set_field_value_in(&conn, &b.id, &status.id, Some(&opt1)).unwrap();

        let snap = snapshot_take_in(&conn, &p.id).unwrap();
        assert_eq!(snap.total, 3);
        assert_eq!(snap.status.get(&opt0).copied().unwrap_or(0), 2);
        assert_eq!(snap.status.get(&opt1).copied().unwrap_or(0), 1);
        assert!(snap.labels.contains_key(&opt0), "名字快照留下（选项改名后历史仍可读）");

        // 同日再采：记的是当天最后状态（覆盖而非追加）
        set_field_value_in(&conn, &a.id, &status.id, Some(&opt1)).unwrap();
        let again = snapshot_take_in(&conn, &p.id).unwrap();
        assert_eq!(again.status.get(&opt1).copied().unwrap_or(0), 2);
        let rows = snapshot_list_in(&conn, &p.id, 30).unwrap();
        assert_eq!(rows.len(), 1, "同日只留一行");
        assert_eq!(rows[0].status.get(&opt1).copied().unwrap_or(0), 2);

        // 草稿/无状态值 → __none__（图表里有自己的一档，不丢总量）
        assert_eq!(SNAPSHOT_NO_STATUS, "__none__");
        assert_eq!(
            snap.status.values().sum::<i64>(),
            snap.total,
            "各档之和 = 总数（不重不漏）"
        );
    }

    /// 读取按天升序（图表左→右 = 早→近），days 参数截断最近 N 天。
    #[test]
    fn snapshot_list_is_ascending_and_limited() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        for (day, n) in [("2026-09-01", 1), ("2026-09-03", 2), ("2026-09-02", 3)] {
            conn.execute(
                "INSERT INTO project_snapshots (project_id, day, counts, taken_at) VALUES (?1, ?2, ?3, ?2)",
                rusqlite::params![p.id, day, format!(r#"{{"total":{n},"status":{{}},"labels":{{}}}}"#)],
            )
            .unwrap();
        }
        let rows = snapshot_list_in(&conn, &p.id, 30).unwrap();
        assert_eq!(rows.iter().map(|s| s.day.as_str()).collect::<Vec<_>>(),
                   vec!["2026-09-01", "2026-09-02", "2026-09-03"]);
        assert_eq!(rows.iter().map(|s| s.total).collect::<Vec<_>>(), vec![1, 3, 2]);
        let last2 = snapshot_list_in(&conn, &p.id, 2).unwrap();
        assert_eq!(last2.iter().map(|s| s.day.as_str()).collect::<Vec<_>>(),
                   vec!["2026-09-02", "2026-09-03"], "只取最近 2 天，仍升序");
    }

    /// 回填链路：导入未命中的条目（repo_id NULL + origin 快照）→ 登记仓库后挂回。
    /// 也守 ghost 判定：非草稿且没落到仓库才算未关联；草稿永远不是。
    #[test]
    fn relink_origin_reattaches_unlinked_items() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        // 导入留下的形态：引用条目没有 repo_id，但有 origin 快照
        conn.execute(
            "INSERT INTO project_items (id, project_id, kind, repo_id, number, rank, added_at, origin_url, origin_type)
             VALUES ('it1', ?1, 'issue', NULL, '42', '1024', '2026-01-01T00:00:00Z', 'https://GitHub.com/O/R.git', 'github')",
            (&p.id,),
        )
        .unwrap();
        let draft = item_add_in(&conn, &p.id, "draft", None, None, Some("草稿"), None).unwrap();
        let items = item_list_in(&conn, &p.id).unwrap();
        let unlinked = items.iter().find(|i| i.id == "it1").unwrap();
        assert!(unlinked.ghost, "没落到仓库的引用条目 = 未关联");
        assert!(!items.iter().find(|i| i.id == draft.id).unwrap().ghost, "草稿不算未关联");
        assert_eq!(unlinked.origin_url.as_deref(), Some("https://GitHub.com/O/R.git"));

        // 还没登记 → 回填 0 条，origin 不动
        assert_eq!(relink_origin_in(&conn, &p.id).unwrap(), 0);

        // 登记同一个仓库（写法不同：小写、无 .git、尾斜杠）→ 归一后挂上
        seed_repo(&conn, "r1");
        conn.execute("UPDATE repos SET remote_url = 'https://github.com/o/r/' WHERE id = 'r1'", []).unwrap();
        assert_eq!(relink_origin_in(&conn, &p.id).unwrap(), 1);
        let after = item_list_in(&conn, &p.id).unwrap();
        let linked = after.iter().find(|i| i.id == "it1").unwrap();
        assert_eq!(linked.repo_id.as_deref(), Some("r1"));
        assert!(!linked.ghost, "挂上后不再是未关联");
        assert_eq!(linked.repo_label.as_deref(), Some("demo"));
        // 幂等：再跑一次没有可回填的
        assert_eq!(relink_origin_in(&conn, &p.id).unwrap(), 0);
    }

    /// 登记行被删（悬挂）的条目也能按 origin 回填——同一把尺子量两种情况。
    #[test]
    fn relink_origin_heals_dangling_repo_links() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        seed_repo(&conn, "r1");
        conn.execute("UPDATE repos SET remote_url = 'https://github.com/o/r' WHERE id = 'r1'", []).unwrap();
        let it = item_add_in(&conn, &p.id, "issue", Some("r1"), Some("7"), None, None).unwrap();
        // 引用时自动记了快照
        assert_eq!(
            item_get_in(&conn, &it.id).unwrap().origin_url.as_deref(),
            Some("https://github.com/o/r")
        );
        // 登记行被删 → 悬挂
        conn.execute("DELETE FROM repos WHERE id = 'r1'", []).unwrap();
        assert!(item_get_in(&conn, &it.id).unwrap().ghost);
        // 重新登记同一来源（新 id）→ 回填
        seed_repo(&conn, "r2");
        conn.execute("UPDATE repos SET remote_url = 'https://github.com/o/r.git' WHERE id = 'r2'", []).unwrap();
        assert_eq!(relink_origin_in(&conn, &p.id).unwrap(), 1);
        assert_eq!(item_get_in(&conn, &it.id).unwrap().repo_id.as_deref(), Some("r2"));
    }

    #[test]
    fn create_seeds_status_and_priority() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        let fields = fields_in(&conn, &p.id).unwrap();
        assert_eq!(fields.len(), 2);
        let status = fields.iter().find(|f| f.kind == "builtin_status").unwrap();
        assert_eq!(status.options.len(), 3);
        assert_eq!(status.options[0].name, "Todo");
        assert_eq!(fields.iter().find(|f| f.kind == "single_select").unwrap().name, "优先级");
    }

    // ---- 甘特依赖边（G3-a）----

    fn seed_items(conn: &Connection, project_id: &str, n: usize) -> Vec<String> {
        (0..n)
            .map(|i| {
                item_add_in(conn, project_id, "draft", None, None, Some(&format!("t{i}")), None)
                    .unwrap()
                    .id
            })
            .collect()
    }

    #[test]
    fn dep_add_list_remove_roundtrip() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        let ids = seed_items(&conn, &p.id, 3);
        // a 依赖 b、a 依赖 c
        dep_add_in(&conn, &p.id, &ids[0], &ids[1]).unwrap();
        dep_add_in(&conn, &p.id, &ids[0], &ids[2]).unwrap();
        // 幂等：重复加同一条边不报错
        dep_add_in(&conn, &p.id, &ids[0], &ids[1]).unwrap();
        let deps = deps_in(&conn, &p.id).unwrap();
        assert_eq!(deps.len(), 2);
        assert!(deps.iter().all(|d| d.origin.is_none()), "G3-a 只写容器真源");
        dep_remove_in(&conn, &p.id, &ids[0], &ids[1]).unwrap();
        assert_eq!(deps_in(&conn, &p.id).unwrap().len(), 1);
    }

    #[test]
    fn dep_rejects_self_cross_project_and_cycle() {
        let conn = mem_db();
        let p1 = project_create_in(&conn, "甲", None, None).unwrap();
        let p2 = project_create_in(&conn, "乙", None, None).unwrap();
        let a = seed_items(&conn, &p1.id, 3);
        let b = seed_items(&conn, &p2.id, 1);

        assert!(dep_add_in(&conn, &p1.id, &a[0], &a[0]).is_err(), "自指拒绝");
        assert!(dep_add_in(&conn, &p1.id, &a[0], &b[0]).is_err(), "跨项目拒绝");

        dep_add_in(&conn, &p1.id, &a[0], &a[1]).unwrap(); // a0 → a1
        dep_add_in(&conn, &p1.id, &a[1], &a[2]).unwrap(); // a1 → a2
        assert!(dep_add_in(&conn, &p1.id, &a[2], &a[0]).is_err(), "三节点环拒绝");
        assert!(dep_add_in(&conn, &p1.id, &a[2], &a[1]).is_err(), "两节点环拒绝");
        assert_eq!(deps_in(&conn, &p1.id).unwrap().len(), 2, "拒绝后不加边");
    }

    #[test]
    fn dep_remove_only_touches_container_truth() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        let ids = seed_items(&conn, &p.id, 2);
        // 手工插一条"平台镜像"行（origin 非空）——删除口子不得动它
        conn.execute(
            "INSERT INTO project_item_deps (item_id, depends_on, origin) VALUES (?1, ?2, 'gh')",
            (&ids[0], &ids[1]),
        )
        .unwrap();
        dep_remove_in(&conn, &p.id, &ids[0], &ids[1]).unwrap();
        let deps = deps_in(&conn, &p.id).unwrap();
        assert_eq!(deps.len(), 1, "镜像行保留（归 G1 刷新管理）");
        assert_eq!(deps[0].origin.as_deref(), Some("gh"));
    }

    #[test]
    fn item_remove_cascades_deps_both_directions() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        let ids = seed_items(&conn, &p.id, 3);
        dep_add_in(&conn, &p.id, &ids[0], &ids[1]).unwrap(); // 出边
        dep_add_in(&conn, &p.id, &ids[2], &ids[0]).unwrap(); // 入边
        item_remove_in(&conn, &ids[0]).unwrap();
        assert_eq!(deps_in(&conn, &p.id).unwrap().len(), 0, "两端级联清空");
    }

    /// 条目归档：**移出视图但保留上下文**——行、字段值、依赖全在，可还原且幂等。
    /// 与「从项目中移除」（删行 + 级联清依赖）的边界在这里钉死，两者不许混。
    #[test]
    fn item_archive_keeps_context_and_is_reversible() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        let ids = seed_items(&conn, &p.id, 2);
        dep_add_in(&conn, &p.id, &ids[0], &ids[1]).unwrap();
        let status = status_field_in(&conn, &p.id).unwrap().unwrap();
        let opt = status.options[1].id.clone();
        set_field_value_in(&conn, &ids[0], &status.id, Some(&opt)).unwrap();

        let item_of = |id: &str| -> ProjectItem {
            item_list_in(&conn, &p.id)
                .unwrap()
                .into_iter()
                .find(|i| i.id == id)
                .expect("归档不删行")
        };

        item_archive_in(&conn, &ids[0], true).unwrap();
        let a = item_of(&ids[0]);
        assert!(a.archived_at.is_some(), "归档写时间戳（归档页要显示归档于…）");
        assert_eq!(item_list_in(&conn, &p.id).unwrap().len(), 2, "行仍在");
        assert_eq!(deps_in(&conn, &p.id).unwrap().len(), 1, "依赖边不动");
        assert_eq!(
            a.field_values.get(&status.id).map(String::as_str),
            Some(opt.as_str()),
            "字段值不动"
        );

        // 幂等：重复归档不报错、仍带时间戳；还原清空
        item_archive_in(&conn, &ids[0], true).unwrap();
        assert!(item_of(&ids[0]).archived_at.is_some());
        item_archive_in(&conn, &ids[0], false).unwrap();
        assert!(item_of(&ids[0]).archived_at.is_none());
        // 重复还原同样幂等
        item_archive_in(&conn, &ids[0], false).unwrap();
        assert!(item_of(&ids[0]).archived_at.is_none());

        assert!(item_archive_in(&conn, "no-such-item", true).is_err(), "坏 id 报错");
    }

    // ---- 父子结构泳道（§3；上级任务）----

    #[test]
    fn parent_set_clear_and_single_valued() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        let ids = seed_items(&conn, &p.id, 3);
        parent_set_in(&conn, &p.id, &ids[0], &ids[1]).unwrap();
        assert_eq!(parents_in(&conn, &p.id).unwrap().len(), 1);
        // 单值：再设一次 = 改上级（覆盖）
        parent_set_in(&conn, &p.id, &ids[0], &ids[2]).unwrap();
        let all = parents_in(&conn, &p.id).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].parent_id, ids[2]);
        // 清除
        parent_clear_in(&conn, &p.id, &ids[0]).unwrap();
        assert!(parents_in(&conn, &p.id).unwrap().is_empty());
    }

    #[test]
    fn parent_rejects_self_cycle_and_cross_project() {
        let conn = mem_db();
        let p1 = project_create_in(&conn, "甲", None, None).unwrap();
        let p2 = project_create_in(&conn, "乙", None, None).unwrap();
        let a = seed_items(&conn, &p1.id, 3);
        let b = seed_items(&conn, &p2.id, 1);
        assert!(parent_set_in(&conn, &p1.id, &a[0], &a[0]).is_err(), "自指拒绝");
        assert!(parent_set_in(&conn, &p1.id, &a[0], &b[0]).is_err(), "跨项目拒绝");
        parent_set_in(&conn, &p1.id, &a[0], &a[1]).unwrap(); // a1 ← a0
        parent_set_in(&conn, &p1.id, &a[1], &a[2]).unwrap(); // a2 ← a1
        assert!(parent_set_in(&conn, &p1.id, &a[2], &a[0]).is_err(), "三节点环拒绝");
        assert!(parent_set_in(&conn, &p1.id, &a[2], &a[1]).is_err(), "两节点环拒绝");
        assert_eq!(parents_in(&conn, &p1.id).unwrap().len(), 2);
    }

    #[test]
    fn parent_remove_cascades_both_directions() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        let ids = seed_items(&conn, &p.id, 3);
        parent_set_in(&conn, &p.id, &ids[0], &ids[1]).unwrap(); // ids0 的上级 = ids1
        parent_set_in(&conn, &p.id, &ids[2], &ids[0]).unwrap(); // ids0 也是别人的上级
        item_remove_in(&conn, &ids[0]).unwrap();
        assert!(parents_in(&conn, &p.id).unwrap().is_empty(), "作为子与作为父都被清");
    }

    #[test]
    fn parent_clear_only_touches_container_truth() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        let ids = seed_items(&conn, &p.id, 2);
        conn.execute(
            "INSERT INTO project_item_parents (item_id, parent_id, origin) VALUES (?1, ?2, 'gh')",
            (&ids[0], &ids[1]),
        )
        .unwrap();
        parent_clear_in(&conn, &p.id, &ids[0]).unwrap();
        let all = parents_in(&conn, &p.id).unwrap();
        assert_eq!(all.len(), 1, "镜像行保留（归同步管理）");
        assert_eq!(all[0].origin.as_deref(), Some("gh"));
    }

    /// 镜像整组同步：清旧插新、不碰容器真源行、跨项目不串。
    #[test]
    fn deps_sync_platform_replaces_only_its_origin() {
        let conn = mem_db();
        let p = project_create_in(&conn, "看板", None, None).unwrap();
        let ids = seed_items(&conn, &p.id, 4);
        // 容器真源边（应永不被动）
        dep_add_in(&conn, &p.id, &ids[0], &ids[1]).unwrap();
        // 旧镜像边（gh）：同步后应被新边组替换
        conn.execute(
            "INSERT INTO project_item_deps (item_id, depends_on, origin) VALUES (?1, ?2, 'gh')",
            (&ids[0], &ids[2]),
        )
        .unwrap();
        let edges = vec![
            (ids[1].clone(), ids[2].clone()),
            (ids[3].clone(), ids[0].clone()),
        ];
        deps_sync_platform_in(&conn, &p.id, "gh", &edges).unwrap();
        let deps = deps_in(&conn, &p.id).unwrap();
        // 真源 1 条 + 新镜像 2 条；旧镜像 (ids0→ids2) 已清
        assert_eq!(deps.len(), 3);
        assert!(deps.iter().any(|d| d.origin.is_none()
            && d.item_id == ids[0] && d.depends_on == ids[1]), "真源行保留");
        assert!(!deps.iter().any(|d| d.origin.is_some()
            && d.item_id == ids[0] && d.depends_on == ids[2]), "旧镜像已清");
        assert!(deps.iter().any(|d| d.origin.as_deref() == Some("gh")
            && d.item_id == ids[1] && d.depends_on == ids[2]), "新镜像已插");
    }

    #[test]
    fn item_add_move_and_rank_order() {
        let conn = mem_db();
        let p = project_create_in(&conn, "board", None, None).unwrap();
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
        item_move_in(&conn, &c.id, None, None, Some(&a.id), Some(&b.id)).unwrap();
        let items = item_list_in(&conn, &p.id).unwrap();
        assert_eq!(items.iter().map(|i| i.id.clone()).collect::<Vec<_>>(), [a_id.clone(), c_id.clone(), b_id.clone()]);
        // 换列：a 移到 Done
        let done = &status.options[2];
        item_move_in(&conn, &a.id, None, Some(&done.id), None, None).unwrap();
        let items = item_list_in(&conn, &p.id).unwrap();
        assert_eq!(items.iter().find(|i| i.id == a.id).unwrap().field_values.get(&status.id).map(|v| v.as_str()), Some(done.id.as_str()));
    }

    #[test]
    fn item_move_sets_arbitrary_column_field() {
        let conn = mem_db();
        let p = project_create_in(&conn, "board", None, None).unwrap();
        let priority = fields_in(&conn, &p.id).unwrap().into_iter().find(|f| f.name == "优先级").unwrap();
        let status = status_field_in(&conn, &p.id).unwrap().unwrap();
        let a = item_add_in(&conn, &p.id, "draft", None, None, Some("a"), None).unwrap();
        // 分列方式 = 优先级：拖到 P1 列只改该字段，状态不动
        let p1 = &priority.options[1];
        let moved = item_move_in(&conn, &a.id, Some(&priority.id), Some(&p1.id), None, None).unwrap();
        assert_eq!(moved.field_values.get(&priority.id).map(|v| v.as_str()), Some(p1.id.as_str()));
        assert_eq!(
            moved.field_values.get(&status.id).map(|v| v.as_str()),
            Some(status.options[0].id.as_str())
        );
    }

    #[test]
    fn field_create_appends_options_and_validates() {
        let conn = mem_db();
        let p = project_create_in(&conn, "board", None, None).unwrap();
        let seeded = fields_in(&conn, &p.id).unwrap().len();
        // 单选：选项自动配 id 与颜色，position 追加在种子字段之后
        let names = vec!["S1".to_string(), "S2".to_string()];
        let f = field_create_in(&conn, &p.id, "迭代", "single_select", &names).unwrap();
        assert_eq!(f.kind, "single_select");
        assert_eq!(f.options.len(), 2);
        assert!(f.options.iter().all(|o| !o.color.is_empty() && o.id.starts_with(&p.id)));
        assert!(f.position >= seeded as i64);
        // 文本/日期类字段无选项
        let text = field_create_in(&conn, &p.id, "备注", "text", &[]).unwrap();
        assert!(text.options.is_empty());
        // 校验：重名 / 空名 / 未知类型 / 单选无选项
        assert!(field_create_in(&conn, &p.id, "迭代", "text", &[]).is_err());
        assert!(field_create_in(&conn, &p.id, "  ", "text", &[]).is_err());
        assert!(field_create_in(&conn, &p.id, "链接", "url", &[]).is_err());
        assert!(field_create_in(&conn, &p.id, "通道", "single_select", &[]).is_err());
        assert_eq!(fields_in(&conn, &p.id).unwrap().len(), seeded + 2);
    }

    #[test]
    fn draft_is_not_ghost() {
        // 回归：草稿 repo_id 为空，但「悬挂」只应指引用了已删仓库的条目——
        // 早先仅看 JOIN 是否落空，把所有草稿都误标成「来源已移除」。
        let conn = mem_db();
        let p = project_create_in(&conn, "board", None, None).unwrap();
        item_add_in(&conn, &p.id, "draft", None, None, Some("草稿标题"), None).unwrap();
        let items = item_list_in(&conn, &p.id).unwrap();
        assert!(!items[0].ghost);
        assert_eq!(items[0].draft_title.as_deref(), Some("草稿标题"));
    }

    #[test]
    fn repo_delete_makes_items_ghost() {
        let conn = mem_db();
        seed_repo(&conn, "r1");
        let p = project_create_in(&conn, "board", None, None).unwrap();
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
        let p = project_create_in(&conn, "board", None, None).unwrap();
        let status = status_field_in(&conn, &p.id).unwrap().unwrap();
        let item = item_add_in(&conn, &p.id, "issue", Some("r1"), Some("7"), None, None).unwrap();
        on_issue_closed_in(&conn, "r1", "7").unwrap();
        let items = item_list_in(&conn, &p.id).unwrap();
        let done_id = status.options.iter().find(|o| o.name == "Done").unwrap().id.clone();
        assert_eq!(items.iter().find(|i| i.id == item.id).unwrap().field_values.get(&status.id).map(|v| v.as_str()), Some(done_id.as_str()));
    }

    #[test]
    fn project_belongs_to_connection_tab() {
        let conn = mem_db();
        // 接入 + 该接入下的登记仓库
        conn.execute(
            "INSERT INTO connections (id, platform, host, label, source_state, created_at)
             VALUES ('c1', 'gitea', 'git.lan', '公司', 'user_set', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        seed_repo(&conn, "r1");
        conn.execute("UPDATE repos SET connection_id = 'c1' WHERE id = 'r1'", []).unwrap();

        let local = project_create_in(&conn, "草稿板", None, None).unwrap();
        let bound = project_create_in(&conn, "公司板", None, Some("c1")).unwrap();
        // 未知接入拒绝
        assert!(project_create_in(&conn, "x", None, Some("nope")).is_err());

        assert_eq!(local.connection_id, None);
        assert_eq!(bound.connection_id.as_deref(), Some("c1"));
    }

    #[test]
    fn repo_binding_roundtrip_and_cascade() {
        let conn = mem_db();
        seed_repo(&conn, "r1");
        let p = project_create_in(&conn, "board", None, None).unwrap();
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
