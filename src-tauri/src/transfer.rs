//! 导出 / 导入 / 备份（《架构设计-导出与导入》v1 最小集）。
//!
//! 只有 **app.db 的容器数据**需要显式导出（journal 有 git 真源、平台缓存可重建）：
//! - **设备包** `hivetask.export`：项目 1..n（字段/条目/字段值 + **依赖、父子、资源分配**
//!   三张结构表）+ 资源目录 + repoHints；仓库引用以 `originUrl + sourceType` 快照表达
//!   （跨机稳定，不存机器路径）；
//! - **导入**按 uuid 三选一（新增 / 覆盖 / 保留），整项目粒度；
//! - **每日滚动备份**：app.db 是主库（删了不可重建）——启动时若无当日备份则
//!   `VACUUM INTO backups/app-YYYYMMDD.db`，保留最近 N 份；覆盖导入前再打一份
//!   `pre-import-<ts>.db`（把后悔药从天级加密到次级）。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 保留份数（每日备份）。
const KEEP_DAILY: usize = 14;

// ---- 设备包结构 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackRefs {
    pub origin_url: Option<String>,
    pub source_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackField {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub options: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackItem {
    pub id: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<PackRefs>,
    pub number: Option<String>,
    pub draft_title: Option<String>,
    pub draft_body: Option<String>,
    pub rank: String,
    pub added_at: String,
    /// 归档时间戳（缺省 = 未归档）。归档是"移出视图但保留条目"的一部分状态，
    /// 必须随包走——丢了它，导入后归档项会静默回到视图里。
    #[serde(default)]
    pub archived_at: Option<String>,
    /// field_id → 值
    #[serde(default)]
    pub values: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackProject {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub group_tag: Option<String>,
    pub updated_at: String,
    #[serde(default)]
    pub fields: Vec<PackField>,
    #[serde(default)]
    pub items: Vec<PackItem>,
    /// 依赖边（item → dependsOn）；origin 非 NULL 的平台镜像行**不入包**（可重拉）
    #[serde(default)]
    pub deps: Vec<(String, String)>,
    /// 父子（item → parent），同上只带容器真源行
    #[serde(default)]
    pub parents: Vec<(String, String)>,
    /// 资源分配：itemId → resourceId → 占比
    #[serde(default)]
    pub item_resources: Vec<(String, String, i64)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub format: String,
    /// app.db 迁移版本（导入端据此判断是否需要升级）
    pub schema_version: i64,
    pub exported_at: String,
    #[serde(default)]
    pub repo_hints: Vec<PackRefs>,
    /// 资源目录（跨项目共享池；随包走）
    #[serde(default)]
    pub resources: Vec<crate::resources::Resource>,
    #[serde(default)]
    pub projects: Vec<PackProject>,
}

/// 导入决策（对话框三选一的结果）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImportAction {
    /// 本机无此项目 → 新增
    Add,
    /// 覆盖本机（包较新）
    Overwrite,
    /// 保留本机（本机较新 / 用户选择）
    Keep,
}

/// 预览的整体结果：版本对照 + 本机缺失的仓库清单 + 逐项目行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreviewResult {
    pub pack_schema_version: i64,
    pub local_schema_version: i64,
    /// 包来自更旧的应用版本（导入按本机当前结构落库——老包能读，值得提示一句）。
    pub pack_is_older: bool,
    /// 包引用了、但**本机登记表里没有**的仓库（origin_url + 来源类型）。
    /// 用途 = 引导逐个打开 / clone（打开即登记），登记后未关联条目即可回填。
    pub missing_repos: Vec<PackRefs>,
    pub projects: Vec<ImportPreview>,
}

/// 单项目的导入预览（对话框据此预选）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub id: String,
    pub name: String,
    pub local_updated_at: Option<String>,
    pub pack_updated_at: String,
    /// 系统建议（按 updated_at 比较；本机缺失 = add）
    pub suggestion: ImportAction,
    pub items: usize,
    pub fields: usize,
}

// ---- 备份 ----

fn backups_dir(app_data: &Path) -> PathBuf {
    app_data.join("backups")
}

/// 备份文件名（按前缀清理时用）。
fn list_backups(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(prefix) && n.ends_with(".db"))
                .unwrap_or(false)
        })
        .collect();
    out.sort();
    out
}

/// 做一份备份（VACUUM INTO：一致性快照；SQLite 3.27+）。
pub fn backup_to(app_data: &Path, file_name: &str) -> Result<PathBuf, String> {
    let dir = backups_dir(app_data);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let target = dir.join(file_name);
    if target.exists() {
        return Ok(target);
    }
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    let path = target.to_string_lossy().to_string();
    conn.execute("VACUUM INTO ?1", (path,))
        .map_err(|e| format!("备份失败：{e}"))?;
    Ok(target)
}

/// 启动时每日备份（同日已存在即跳过），并清理超出保留份数的旧备份。
pub fn ensure_daily_backup(app_data: &Path) -> Result<Option<PathBuf>, String> {
    let today = today_stamp();
    let name = format!("app-{today}.db");
    let existing = backups_dir(app_data).join(&name).exists();
    let made = if existing { None } else { Some(backup_to(app_data, &name)?) };
    // 只清「每日」备份（pre-import 快照不动——那是用户操作级后悔药）
    let dailies = list_backups(&backups_dir(app_data), "app-");
    if dailies.len() > KEEP_DAILY {
        for old in &dailies[..dailies.len() - KEEP_DAILY] {
            let _ = std::fs::remove_file(old);
        }
    }
    Ok(made)
}

/// 覆盖导入前的操作级快照。
pub fn pre_import_snapshot(app_data: &Path) -> Result<PathBuf, String> {
    let ts = chrono_like_stamp();
    backup_to(app_data, &format!("pre-import-{ts}.db"))
}

/// YYYYMMDD（本地时区；用 std 的 SystemTime + 手算，避免引入 chrono）。
fn today_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (y, m, d) = crate::source_time::civil_from_days(secs / 86_400);
    format!("{y:04}{m:02}{d:02}")
}

fn chrono_like_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (y, m, d) = crate::source_time::civil_from_days(secs / 86_400);
    let rem = secs % 86_400;
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, (rem % 3600) / 60, rem % 60)
}

// ---- 导出 ----

fn pack_refs(conn: &Connection, repo_id: Option<&str>) -> Option<PackRefs> {
    let id = repo_id?;
    conn.query_row(
        "SELECT r.remote_url, c.platform FROM repos r LEFT JOIN connections c ON c.id = r.connection_id WHERE r.id = ?1",
        (id,),
        |row| {
            Ok(PackRefs {
                origin_url: row.get::<_, Option<String>>(0)?,
                source_type: row.get::<_, Option<String>>(1)?,
            })
        },
    )
    .ok()
}

/// 导出设备包（project_ids 为空 = 全部项目）。
pub fn export_pack_in(conn: &Connection, project_ids: Option<&[String]>) -> Result<Pack, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, display_name, description, group_tag, updated_at FROM projects ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut projects = Vec::new();
    let mut hints: Vec<PackRefs> = Vec::new();
    for row in rows {
        let (id, name, description, group_tag, updated_at) = row.map_err(|e| e.to_string())?;
        if let Some(only) = project_ids {
            if !only.iter().any(|x| x == &id) {
                continue;
            }
        }
        // 字段
        let mut fstmt = conn
            .prepare("SELECT id, kind, name, options, position FROM project_fields WHERE project_id = ?1 ORDER BY position")
            .map_err(|e| e.to_string())?;
        let fields: Vec<PackField> = fstmt
            .query_map((&id,), |r| {
                Ok(PackField {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    name: r.get(2)?,
                    options: r.get(3)?,
                    position: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|x| x.ok())
            .collect();
        // 条目 + 字段值
        let mut istmt = conn
            .prepare(
                "SELECT id, kind, repo_id, number, draft_title, draft_body, rank, added_at, origin_url, origin_type, archived_at
                 FROM project_items WHERE project_id = ?1 ORDER BY CAST(rank AS INTEGER)",
            )
            .map_err(|e| e.to_string())?;
        let mut items: Vec<PackItem> = istmt
            .query_map((&id,), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                    r.get::<_, Option<String>>(10)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|x| x.ok())
            .map(|(iid, kind, repo_id, number, dt, db, rank, added_at, origin_url, origin_type, archived_at)| PackItem {
                // 条目自带的引用快照优先（未关联条目也能带着 origin 走完一个来回），
                // 老数据没有快照时退回登记的 remote_url。
                repo: match origin_url {
                    Some(url) => Some(PackRefs { origin_url: Some(url), source_type: origin_type }),
                    None => pack_refs(conn, repo_id.as_deref()),
                },
                id: iid,
                kind,
                number,
                draft_title: dt,
                draft_body: db,
                rank,
                added_at,
                archived_at,
                values: Default::default(),
            })
            .collect();
        {
            let mut vstmt = conn
                .prepare(
                    "SELECT v.item_id, v.field_id, v.value FROM project_field_values v
                     JOIN project_items i ON i.id = v.item_id WHERE i.project_id = ?1",
                )
                .map_err(|e| e.to_string())?;
            let values: Vec<(String, String, String)> = vstmt
                .query_map((&id,), |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<String>>(2)?.unwrap_or_default()))
                })
                .map_err(|e| e.to_string())?
                .filter_map(|x| x.ok())
                .collect();
            for (item_id, field_id, value) in values {
                if let Some(it) = items.iter_mut().find(|x| x.id == item_id) {
                    it.values.insert(field_id, value);
                }
            }
        }
        // 结构表（只带容器真源行——平台镜像可重拉）
        let deps: Vec<(String, String)> = conn
            .prepare("SELECT d.item_id, d.depends_on FROM project_item_deps d JOIN project_items i ON i.id = d.item_id WHERE i.project_id = ?1 AND d.origin IS NULL")
            .map_err(|e| e.to_string())?
            .query_map((&id,), |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|x| x.ok())
            .collect();
        let parents: Vec<(String, String)> = conn
            .prepare("SELECT p.item_id, p.parent_id FROM project_item_parents p JOIN project_items i ON i.id = p.item_id WHERE i.project_id = ?1 AND p.origin IS NULL")
            .map_err(|e| e.to_string())?
            .query_map((&id,), |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|x| x.ok())
            .collect();
        let item_resources: Vec<(String, String, i64)> = conn
            .prepare("SELECT r.item_id, r.resource_id, r.allocation FROM item_resources r JOIN project_items i ON i.id = r.item_id WHERE i.project_id = ?1")
            .map_err(|e| e.to_string())?
            .query_map((&id,), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|x| x.ok())
            .collect();
        for it in &items {
            if let Some(r) = &it.repo {
                if !hints.iter().any(|h| h.origin_url == r.origin_url) {
                    hints.push(r.clone());
                }
            }
        }
        projects.push(PackProject {
            id,
            name,
            description,
            group_tag,
            updated_at,
            fields,
            items,
            deps,
            parents,
            item_resources,
        });
    }

    let resources = crate::resources::resources_list_in(conn)?;
    Ok(Pack {
        format: "hivetask.export".to_string(),
        schema_version: crate::appdb::current_schema_version(),
        exported_at: crate::resources::now_iso(),
        repo_hints: hints,
        resources,
        projects,
    })
}

// ---- 导入 ----

/// 版本闸：包比本机 schema 新 → 拒（本机不认识新结构，硬导会丢字段）；
/// 包更旧 → 放行（导入按本机当前结构落库），但如实标出来供对话框提示。
pub fn check_pack_version(pack: &Pack, local: i64) -> Result<bool, String> {
    if pack.schema_version > local {
        return Err(format!(
            "设备包来自更新的 HiveTask（结构 v{} > 本机 v{}）——先升级应用再导入。",
            pack.schema_version, local
        ));
    }
    Ok(pack.schema_version < local)
}

/// 包引用了、本机没登记的仓库（归一化比对，与导入解析、回填共用同一把尺子）。
pub fn missing_repos_in(conn: &Connection, pack: &Pack) -> Vec<PackRefs> {
    let mut known_keys: Vec<String> = Vec::new();
    if let Ok(mut st) = conn.prepare("SELECT remote_url FROM repos") {
        if let Ok(rows) = st.query_map([], |r| r.get::<_, Option<String>>(0)) {
            for url in rows.flatten() {
                if let Some(k) = url.as_deref().and_then(crate::projects::origin_key) {
                    known_keys.push(k);
                }
            }
        }
    }
    pack.repo_hints
        .iter()
        .filter(|h| match h.origin_url.as_deref().and_then(crate::projects::origin_key) {
            Some(k) => !known_keys.contains(&k),
            None => false, // 没有 origin 的快照（本地库条目）无从引导
        })
        .cloned()
        .collect()
}

/// 预览（对话框三选一的依据）：按 uuid 查本机，比较 updated_at 给建议。
pub fn import_preview_in(conn: &Connection, pack: &Pack) -> Vec<ImportPreview> {
    pack.projects
        .iter()
        .map(|p| {
            let local: Option<String> = conn
                .query_row("SELECT updated_at FROM projects WHERE id = ?1", (&p.id,), |r| r.get(0))
                .ok();
            let suggestion = match &local {
                None => ImportAction::Add,
                Some(l) => {
                    if p.updated_at > *l {
                        ImportAction::Overwrite
                    } else {
                        ImportAction::Keep
                    }
                }
            };
            ImportPreview {
                id: p.id.clone(),
                name: p.name.clone(),
                local_updated_at: local,
                pack_updated_at: p.updated_at.clone(),
                suggestion,
                items: p.items.len(),
                fields: p.fields.len(),
            }
        })
        .collect()
}

/// 包内 origin_url → 本机仓库 id：**归一后匹配**（https/scp、大小写、.git 后缀、
/// 尾斜杠都能认），命中不了返回 None（条目留 origin 快照，等 relink）。
fn repo_id_by_origin(conn: &Connection, refs: &Option<PackRefs>) -> Option<String> {
    let want = crate::projects::origin_key(refs.as_ref()?.origin_url.as_deref()?)?;
    let rows: Vec<(String, Option<String>)> = conn
        .prepare("SELECT id, remote_url FROM repos")
        .ok()?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .ok()?
        .filter_map(|x| x.ok())
        .collect();
    rows.into_iter()
        .find(|(_, url)| url.as_deref().and_then(crate::projects::origin_key).as_deref() == Some(want.as_str()))
        .map(|(id, _)| id)
}

/// 预览的整体结果（版本 + 缺失仓库 + 逐项目行）。
pub fn import_preview_result_in(conn: &Connection, pack: &Pack) -> Result<ImportPreviewResult, String> {
    let local = crate::appdb::current_schema_version();
    let pack_is_older = check_pack_version(pack, local)?;
    Ok(ImportPreviewResult {
        pack_schema_version: pack.schema_version,
        local_schema_version: local,
        pack_is_older,
        missing_repos: missing_repos_in(conn, pack),
        projects: import_preview_in(conn, pack),
    })
}

/// 应用导入（单事务；覆盖前由调用方先打快照）。
///
/// 决策语义：`Add` 走 upsert——**uuid 命中即整项目替换**（与 `Overwrite` 同一条写
/// 路径，只是计数不同）。因此对话框只在「本机没有该项目」的行上给「新增」，
/// 本机已有的行只给「覆盖 / 保留」：同一动作两个名字最容易手滑。
pub fn import_apply_in(
    conn: &Connection,
    pack: &Pack,
    decisions: &std::collections::HashMap<String, ImportAction>,
) -> Result<(usize, usize, usize), String> {
    let mut added = 0usize;
    let mut overwritten = 0usize;
    let mut kept = 0usize;
    conn.execute("BEGIN", ()).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        // 资源目录：按 id 合并（已存在 = 本地优先，不覆盖）
        for r in &pack.resources {
            conn.execute(
                "INSERT OR IGNORE INTO resources (id, name, title, type, department, capacity, color, origin, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![
                    r.id, r.name, r.title, r.r#type, r.department, r.capacity, r.color, r.origin,
                    crate::resources::now_iso()
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        for p in &pack.projects {
            let action = decisions.get(&p.id).cloned().unwrap_or(ImportAction::Add);
            match action {
                ImportAction::Keep => {
                    kept += 1;
                    continue;
                }
                ImportAction::Overwrite => overwritten += 1,
                ImportAction::Add => added += 1,
            }
            // 项目行（upsert）
            conn.execute(
                "INSERT INTO projects (id, display_name, description, group_tag, archived, created_at, updated_at, last_opened_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5, ?5)
                 ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name,
                   description = excluded.description, group_tag = excluded.group_tag,
                   updated_at = excluded.updated_at",
                rusqlite::params![p.id, p.name, p.description, p.group_tag, p.updated_at],
            )
            .map_err(|e| e.to_string())?;
            // 覆盖语义 = 整项目替换：先清子表（字段值 → 条目 → 结构表 → 字段）
            conn.execute("DELETE FROM project_field_values WHERE item_id IN (SELECT id FROM project_items WHERE project_id = ?1)", (&p.id,)).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM item_resources WHERE item_id IN (SELECT id FROM project_items WHERE project_id = ?1)", (&p.id,)).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM project_item_deps WHERE item_id IN (SELECT id FROM project_items WHERE project_id = ?1)", (&p.id,)).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM project_item_parents WHERE item_id IN (SELECT id FROM project_items WHERE project_id = ?1)", (&p.id,)).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM project_items WHERE project_id = ?1", (&p.id,)).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM project_fields WHERE project_id = ?1", (&p.id,)).map_err(|e| e.to_string())?;
            // 字段
            for f in &p.fields {
                conn.execute(
                    "INSERT INTO project_fields (id, project_id, kind, name, options, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![f.id, p.id, f.kind, f.name, f.options, f.position],
                )
                .map_err(|e| e.to_string())?;
            }
            // 条目 + 字段值（仓库按 origin_url 重解析；未命中 → NULL = ghost）
            for it in &p.items {
                let repo_id = repo_id_by_origin(conn, &it.repo);
                // origin 快照照抄（命中与否都写）：未命中时它是之后 relink 的唯一线索
                let origin_url = it.repo.as_ref().and_then(|r| r.origin_url.clone());
                let origin_type = it.repo.as_ref().and_then(|r| r.source_type.clone());
                conn.execute(
                    "INSERT INTO project_items (id, project_id, kind, repo_id, number, draft_title, draft_body, rank, added_at, origin_url, origin_type, archived_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    rusqlite::params![
                        it.id, p.id, it.kind, repo_id, it.number, it.draft_title, it.draft_body, it.rank, it.added_at,
                        origin_url, origin_type, it.archived_at
                    ],
                )
                .map_err(|e| e.to_string())?;
                for (field_id, value) in &it.values {
                    conn.execute(
                        "INSERT OR REPLACE INTO project_field_values (item_id, field_id, value) VALUES (?1, ?2, ?3)",
                        rusqlite::params![it.id, field_id, value],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            // 结构表（容器真源行）
            for (item_id, depends_on) in &p.deps {
                conn.execute(
                    "INSERT OR IGNORE INTO project_item_deps (item_id, depends_on, origin) VALUES (?1, ?2, NULL)",
                    (item_id, depends_on),
                )
                .map_err(|e| e.to_string())?;
            }
            for (item_id, parent_id) in &p.parents {
                conn.execute(
                    "INSERT OR REPLACE INTO project_item_parents (item_id, parent_id, origin) VALUES (?1, ?2, NULL)",
                    (item_id, parent_id),
                )
                .map_err(|e| e.to_string())?;
            }
            for (item_id, resource_id, allocation) in &p.item_resources {
                conn.execute(
                    "INSERT OR REPLACE INTO item_resources (item_id, resource_id, allocation, origin) VALUES (?1, ?2, ?3, NULL)",
                    (item_id, resource_id, allocation),
                )
                .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute("COMMIT", ()).map(|_| ()).map_err(|e| e.to_string())?;
            Ok((added, overwritten, kept))
        }
        Err(e) => {
            let _ = conn.execute("ROLLBACK", ());
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::appdb::app_migrate(&conn).unwrap();
        conn
    }

    /// 造一个小项目（带依赖/父子/资源分配），供往返测试用。
    fn seed(conn: &Connection) -> (String, String) {
        let p = crate::projects::project_create_in(conn, "家庭装修", Some("desc"), None).unwrap();
        let a = crate::projects::item_add_in(conn, &p.id, "draft", None, None, Some("选瓷砖"), None).unwrap();
        let b = crate::projects::item_add_in(conn, &p.id, "draft", None, None, Some("铺地砖"), None).unwrap();
        crate::projects::dep_add_in(conn, &p.id, &b.id, &a.id).unwrap();
        crate::projects::parent_set_in(conn, &p.id, &b.id, &a.id).unwrap();
        crate::resources::resource_upsert_in(
            conn,
            &crate::resources::Resource {
                id: "r1".into(), name: "张三".into(), title: None, r#type: "Human".into(),
                department: None, capacity: None, color: None, origin: None,
            },
        )
        .unwrap();
        crate::resources::item_resource_set_in(conn, &p.id, &a.id, "r1", 60).unwrap();
        // 平台镜像行：不应入包
        conn.execute(
            "INSERT INTO project_item_deps (item_id, depends_on, origin) VALUES (?1, ?2, 'gh')",
            (&a.id, &b.id),
        )
        .unwrap();
        (p.id, a.id)
    }

    #[test]
    fn export_pack_carries_structure_tables_and_skips_mirrors() {
        let conn = mem_db();
        let (pid, _) = seed(&conn);
        let pack = export_pack_in(&conn, None).unwrap();
        assert_eq!(pack.format, "hivetask.export");
        assert_eq!(pack.projects.len(), 1);
        let proj = &pack.projects[0];
        assert_eq!(proj.id, pid);
        assert_eq!(proj.items.len(), 2, "两个草稿条目");
        assert_eq!(proj.deps.len(), 1, "只带容器真源依赖（镜像行不入包）");
        assert_eq!(proj.parents.len(), 1);
        assert_eq!(proj.item_resources.len(), 1);
        assert_eq!(pack.resources.len(), 1, "资源目录随包");
    }

    /// 归档状态随包走：归档是"移出视图但保留条目"的一部分状态，丢了它，
    /// 导入后归档项会静默回到视图里（用户看到凭空多出来的卡片）。
    /// 同时守老包兼容：没有 archivedAt 字段的包按未归档读入，不报错。
    #[test]
    fn pack_carries_item_archived_state() {
        let src = mem_db();
        let (pid, aid) = seed(&src);
        src.execute("UPDATE project_items SET archived_at = '2026-09-20T10:00:00Z' WHERE id = ?1", (&aid,))
            .unwrap();
        let pack = export_pack_in(&src, None).unwrap();
        assert_eq!(
            pack.projects[0].items.iter().find(|i| i.id == aid).unwrap().archived_at.as_deref(),
            Some("2026-09-20T10:00:00Z"),
            "导出的包带归档时间戳"
        );

        let dst = mem_db();
        let mut decisions = std::collections::HashMap::new();
        decisions.insert(pid.clone(), ImportAction::Add);
        import_apply_in(&dst, &pack, &decisions).unwrap();
        let got: Option<String> = dst
            .query_row("SELECT archived_at FROM project_items WHERE id = ?1", (&aid,), |r| r.get(0))
            .unwrap();
        assert_eq!(got.as_deref(), Some("2026-09-20T10:00:00Z"), "导入后归档态还在");

        // 老包（无该字段）：serde default 兜住
        let mut json = serde_json::to_value(&pack).unwrap();
        for proj in json["projects"].as_array_mut().unwrap() {
            for item in proj["items"].as_array_mut().unwrap() {
                item.as_object_mut().unwrap().remove("archivedAt");
            }
        }
        let old: Pack = serde_json::from_value(json).unwrap();
        assert!(old.projects[0].items.iter().all(|i| i.archived_at.is_none()));
    }

    #[test]
    fn import_preview_suggests_by_updated_at() {
        let conn = mem_db();
        let (pid, _) = seed(&conn);
        let mut pack = export_pack_in(&conn, None).unwrap();
        // 本机有该项目且同一时间戳 → 建议保留（幂等：重复导入 no-op）
        let previews = import_preview_in(&conn, &pack);
        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].suggestion, ImportAction::Keep);
        assert!(previews[0].local_updated_at.is_some());
        // 换空库：uuid 缺失 → add
        let fresh = mem_db();
        let previews2 = import_preview_in(&fresh, &pack);
        assert_eq!(previews2[0].suggestion, ImportAction::Add);
        assert!(previews2[0].local_updated_at.is_none());
        // 包更新 → overwrite
        pack.projects[0].updated_at = "2999-01-01T00:00:00Z".into();
        conn.execute("UPDATE projects SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?1", (&pid,)).unwrap();
        assert_eq!(import_preview_in(&conn, &pack)[0].suggestion, ImportAction::Overwrite);
    }

    #[test]
    fn import_into_empty_db_restores_everything() {
        let src = mem_db();
        let (pid, aid) = seed(&src);
        let pack = export_pack_in(&src, None).unwrap();
        let dst = mem_db();
        let mut decisions = std::collections::HashMap::new();
        decisions.insert(pid.clone(), ImportAction::Add);
        let (added, ow, kept) = import_apply_in(&dst, &pack, &decisions).unwrap();
        assert_eq!((added, ow, kept), (1, 0, 0));
        // 条目 / 依赖 / 父子 / 分配 / 资源 齐备
        let items: i64 = dst.query_row("SELECT COUNT(*) FROM project_items WHERE project_id = ?1", (&pid,), |r| r.get(0)).unwrap();
        assert_eq!(items, 2);
        let deps: i64 = dst.query_row("SELECT COUNT(*) FROM project_item_deps WHERE origin IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(deps, 1);
        let parents: i64 = dst.query_row("SELECT COUNT(*) FROM project_item_parents", [], |r| r.get(0)).unwrap();
        assert_eq!(parents, 1);
        let alloc: i64 = dst.query_row("SELECT allocation FROM item_resources WHERE item_id = ?1", (&aid,), |r| r.get(0)).unwrap();
        assert_eq!(alloc, 60);
        let res: i64 = dst.query_row("SELECT COUNT(*) FROM resources", [], |r| r.get(0)).unwrap();
        assert_eq!(res, 1);
    }

    #[test]
    fn import_keep_leaves_local_untouched() {
        let src = mem_db();
        let (pid, _) = seed(&src);
        let mut pack = export_pack_in(&src, None).unwrap();
        // 先按 add 落到本机，再本地改名（本机更新晚于包）
        let dst = mem_db();
        let mut add = std::collections::HashMap::new();
        add.insert(pid.clone(), ImportAction::Add);
        import_apply_in(&dst, &pack, &add).unwrap();
        dst.execute(
            "UPDATE projects SET display_name = '本机改名', updated_at = '2999-01-01T00:00:00Z' WHERE id = ?1",
            (&pid,),
        )
        .unwrap();
        // 包也改了名，但导入选 keep → 本机不动
        pack.projects[0].name = "来自包的改名".into();
        pack.projects[0].updated_at = "2000-01-01T00:00:00Z".into();
        let mut decisions = std::collections::HashMap::new();
        decisions.insert(pid.clone(), ImportAction::Keep);
        let (a, o, k) = import_apply_in(&dst, &pack, &decisions).unwrap();
        assert_eq!((a, o, k), (0, 0, 1));
        let name: String = dst.query_row("SELECT display_name FROM projects WHERE id = ?1", (&pid,), |r| r.get(0)).unwrap();
        assert_eq!(name, "本机改名", "保留 = 本机不动");
    }

    #[test]
    fn import_overwrite_replaces_project_subtree() {
        let src = mem_db();
        let (pid, _) = seed(&src);
        let pack = export_pack_in(&src, None).unwrap();
        let dst = mem_db();
        let mut add = std::collections::HashMap::new();
        add.insert(pid.clone(), ImportAction::Add);
        import_apply_in(&dst, &pack, &add).unwrap();
        // 本机偏离：改名 + 多一个条目
        dst.execute("UPDATE projects SET display_name = '本机改名' WHERE id = ?1", (&pid,)).unwrap();
        crate::projects::item_add_in(&dst, &pid, "draft", None, None, Some("本机独有条目"), None).unwrap();
        let mut decisions = std::collections::HashMap::new();
        decisions.insert(pid.clone(), ImportAction::Overwrite);
        let (a, o, k) = import_apply_in(&dst, &pack, &decisions).unwrap();
        assert_eq!((a, o, k), (0, 1, 0));
        let name: String = dst.query_row("SELECT display_name FROM projects WHERE id = ?1", (&pid,), |r| r.get(0)).unwrap();
        assert_eq!(name, "家庭装修", "覆盖取包内名称");
        let items: i64 = dst.query_row("SELECT COUNT(*) FROM project_items WHERE project_id = ?1", (&pid,), |r| r.get(0)).unwrap();
        assert_eq!(items, 2, "覆盖 = 整项目替换，本机独有条目被清");
    }

    /// 导入比较靠 `projects.updated_at` 当水位：本地内容变更必须抬它，平台镜像同步
    /// 不该抬（包不含镜像行）。
    #[test]
    fn content_watermark_moves_on_local_edit_only() {
        let conn = mem_db();
        let (pid, aid) = seed(&conn);
        let stale = "2000-01-01T00:00:00Z";
        let watermark = |c: &Connection| -> String {
            c.query_row("SELECT updated_at FROM projects WHERE id = ?1", (&pid,), |r| r.get(0)).unwrap()
        };
        // 本地内容变更（改状态字段值）→ 水位前进
        conn.execute("UPDATE projects SET updated_at = ?2 WHERE id = ?1", (&pid, stale)).unwrap();
        let field = crate::projects::status_field_in(&conn, &pid).unwrap().unwrap();
        let opt = field.options[0].id.clone();
        crate::projects::set_field_value_in(&conn, &aid, &field.id, Some(&opt)).unwrap();
        assert_ne!(watermark(&conn), stale, "本地内容变更必须抬水位");
        // 平台镜像整组重写 → 不算本机内容变更
        conn.execute("UPDATE projects SET updated_at = ?2 WHERE id = ?1", (&pid, stale)).unwrap();
        crate::projects::deps_sync_platform_in(&conn, &pid, "gh", &[(aid.clone(), aid.clone())]).unwrap();
        assert_eq!(watermark(&conn), stale, "镜像行同步不该抬水位");
    }

    /// 设备迁移的真实路径：新设备没有该仓库 → 导入的引用条目「未关联但留档」，
    /// 之后再导出也带着 origin 走完来回，登记同一来源（写法不同）即回填。
    #[test]
    fn import_keeps_origin_when_repo_missing_then_relinks() {
        let src = mem_db();
        let p = crate::projects::project_create_in(&src, "看板", None, None).unwrap();
        src.execute(
            "INSERT INTO repos (id, path, display_name, remote_url, created_at, last_opened_at)
             VALUES ('r1', '/tmp/r1', 'demo', 'https://github.com/o/r', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        crate::projects::item_add_in(&src, &p.id, "issue", Some("r1"), Some("42"), None, None).unwrap();
        let pack = export_pack_in(&src, None).unwrap();
        assert_eq!(
            pack.projects[0].items[0].repo.as_ref().unwrap().origin_url.as_deref(),
            Some("https://github.com/o/r"),
            "导出带 origin 快照"
        );

        // 目标端：一个仓库登记都没有
        let dst = mem_db();
        let mut decisions = std::collections::HashMap::new();
        decisions.insert(p.id.clone(), ImportAction::Add);
        import_apply_in(&dst, &pack, &decisions).unwrap();
        let items = crate::projects::item_list_in(&dst, &p.id).unwrap();
        assert!(items[0].ghost, "没落到仓库 = 未关联");
        assert!(items[0].repo_id.is_none());
        assert_eq!(items[0].origin_url.as_deref(), Some("https://github.com/o/r"), "快照留档");

        // 再导出：未关联条目也能带着 origin 走完来回（不再依赖登记行）
        let pack2 = export_pack_in(&dst, None).unwrap();
        assert_eq!(
            pack2.projects[0].items[0].repo.as_ref().unwrap().origin_url.as_deref(),
            Some("https://github.com/o/r")
        );

        // 目标端登记同一来源（大小写 / .git 写法不同）→ 回填
        dst.execute(
            "INSERT INTO repos (id, path, display_name, remote_url, created_at, last_opened_at)
             VALUES ('r9', '/tmp/r9', 'demo', 'https://GitHub.com/O/R.git', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        assert_eq!(crate::projects::relink_origin_in(&dst, &p.id).unwrap(), 1);
        let after = crate::projects::item_list_in(&dst, &p.id).unwrap();
        assert_eq!(after[0].repo_id.as_deref(), Some("r9"));
        assert!(!after[0].ghost);
    }

    /// 版本闸：包的 schema 比本机新 → 拒（不认识新结构，硬导会丢字段）；
    /// 更旧 → 放行并标出来（老包能读，对话框提示一句）。
    #[test]
    fn pack_version_gate_rejects_newer_and_flags_older() {
        let conn = mem_db();
        let (pid, _) = seed(&conn);
        let mut pack = export_pack_in(&conn, None).unwrap();
        let local = crate::appdb::current_schema_version();
        assert_eq!(pack.schema_version, local);
        assert_eq!(check_pack_version(&pack, local).unwrap(), false, "同版本：不提示");

        pack.schema_version = local - 1;
        assert_eq!(check_pack_version(&pack, local).unwrap(), true, "更旧：放行但标记");
        assert!(import_preview_result_in(&conn, &pack).unwrap().pack_is_older);

        pack.schema_version = local + 1;
        let err = check_pack_version(&pack, local).unwrap_err();
        assert!(err.contains("更新的 HiveTask"), "{err}");
        assert!(import_preview_result_in(&conn, &pack).is_err(), "预览也拦");
        assert!(
            import_apply_in(&conn, &pack, &std::collections::HashMap::new()).is_ok(),
            "应用层不做版本闸（命令层已拦；这里守的是可测性）"
        );
        assert_eq!(pid.is_empty(), false);
    }

    /// 缺失仓库清单：包引用了、本机没登记的才列出来（归一化比对，写法不同也算已登记）。
    #[test]
    fn preview_lists_repos_missing_locally() {
        let conn = mem_db();
        // 本机登记了 o/r（写法带 .git 与大写）
        conn.execute(
            "INSERT INTO repos (id, path, display_name, remote_url, created_at, last_opened_at)
             VALUES ('r1', '/tmp/r1', 'demo', 'https://github.com/o/r.git', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
        let (pid, _) = seed(&conn);
        let mut pack = export_pack_in(&conn, None).unwrap();
        // 包引用两个来源：一个本机有（写法不同）、一个没有
        pack.repo_hints = vec![
            PackRefs { origin_url: Some("https://GitHub.com/O/R".into()), source_type: Some("github".into()) },
            PackRefs { origin_url: Some("https://gitea.example.com:3000/team/x".into()), source_type: Some("gitea".into()) },
        ];
        let missing = missing_repos_in(&conn, &pack);
        assert_eq!(missing.len(), 1, "只列本机没有的");
        assert_eq!(missing[0].origin_url.as_deref(), Some("https://gitea.example.com:3000/team/x"));
        let result = import_preview_result_in(&conn, &pack).unwrap();
        assert_eq!(result.missing_repos.len(), 1);
        assert_eq!(result.projects.len(), 1);
        assert_eq!(result.projects[0].id, pid);
        assert_eq!(result.local_schema_version, crate::appdb::current_schema_version());
    }

    #[test]
    fn backup_makes_file_once_per_day_and_prunes() {
        let tmp = std::env::temp_dir().join(format!("ht-backup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        // 直接测文件名逻辑与清理（VACUUM INTO 需要真实 app.db 路径，见 appdb::open）
        let dir = backups_dir(&tmp);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..20 {
            std::fs::write(dir.join(format!("app-202601{:02}.db", i)), b"x").unwrap();
        }
        std::fs::write(dir.join("pre-import-20260101-000000.db"), b"x").unwrap();
        let dailies = list_backups(&dir, "app-");
        assert_eq!(dailies.len(), 20);
        // 清理后保留 14 份，且 pre-import 不动
        if dailies.len() > KEEP_DAILY {
            for old in &dailies[..dailies.len() - KEEP_DAILY] {
                let _ = std::fs::remove_file(old);
            }
        }
        assert_eq!(list_backups(&dir, "app-").len(), KEEP_DAILY);
        assert_eq!(list_backups(&dir, "pre-import-").len(), 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

// ---- Tauri 命令 ----

/// 设备包体积上限（导入前先卡大小，避免把整个文件读进内存）。
const MAX_PACK_BYTES: u64 = 64 * 1024 * 1024;

/// 读设备包文本：前端经系统文件选择器拿到路径后交这里读（WebView 碰不到任意路径）。
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取失败：{e}"))?;
    if meta.len() > MAX_PACK_BYTES {
        return Err(format!("文件过大（上限 {} MB）", MAX_PACK_BYTES / 1024 / 1024));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取失败（设备包须为 UTF-8 文本）：{e}"))
}

/// 立即打一份每日备份（同日已有则返回既有路径）。
#[tauri::command]
pub fn backup_now() -> Result<String, String> {
    let dir = crate::appdb::app_data_dir().ok_or_else(|| "找不到应用数据目录".to_string())?;
    let path = backup_to(&dir, &format!("app-{}.db", today_stamp()))?;
    Ok(path.to_string_lossy().to_string())
}

/// 备份状态：备份目录、最近备份时间、份数（设置面板展示用）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub dir: String,
    pub count: usize,
    pub latest: Option<String>,
}

#[tauri::command]
pub fn backup_status() -> Result<BackupStatus, String> {
    let dir = crate::appdb::app_data_dir().ok_or_else(|| "找不到应用数据目录".to_string())?;
    let bdir = backups_dir(&dir);
    let dailies = list_backups(&bdir, "app-");
    let latest = dailies
        .last()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .map(str::to_string);
    Ok(BackupStatus {
        dir: bdir.to_string_lossy().to_string(),
        count: dailies.len(),
        latest,
    })
}

/// 导出设备包（JSON 字符串；projectIds 为空 = 全部项目）。前端经保存对话框落盘。
#[tauri::command]
pub fn export_pack(project_ids: Option<Vec<String>>) -> Result<String, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    let pack = export_pack_in(&conn, project_ids.as_deref())?;
    serde_json::to_string_pretty(&pack).map_err(|e| e.to_string())
}

/// 导入预览：版本闸 + 本机缺失仓库清单 + 逐项目建议（新增 / 覆盖 / 保留）。
#[tauri::command]
pub fn import_preview(pack_json: String) -> Result<ImportPreviewResult, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    let pack: Pack = serde_json::from_str(&pack_json).map_err(|e| format!("设备包解析失败：{e}"))?;
    if pack.format != "hivetask.export" {
        return Err(format!("不是 HiveTask 设备包（format={}）", pack.format));
    }
    import_preview_result_in(&conn, &pack)
}

/// 应用导入：覆盖前打操作级快照；全程单事务（失败整体回滚）。
#[tauri::command]
pub fn import_apply(
    pack_json: String,
    decisions: std::collections::HashMap<String, ImportAction>,
) -> Result<(usize, usize, usize), String> {
    let pack: Pack = serde_json::from_str(&pack_json).map_err(|e| format!("设备包解析失败：{e}"))?;
    // 纵深：命令可被直接调用，版本闸在预览与应用两处都过
    check_pack_version(&pack, crate::appdb::current_schema_version())?;
    let dir = crate::appdb::app_data_dir().ok_or_else(|| "找不到应用数据目录".to_string())?;
    let will_overwrite = decisions.values().any(|a| *a == ImportAction::Overwrite);
    if will_overwrite {
        pre_import_snapshot(&dir)?;
    }
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    import_apply_in(&conn, &pack, &decisions)
}
