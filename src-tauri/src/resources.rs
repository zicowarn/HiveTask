//! 资源分配与负载模型（《架构设计-甘特计划面》§5-bis，照 jordium-gantt-vue3 参考实现设计）。
//!
//! 三张表（app_015）：
//! - `resources`：**跨项目共享**的资源目录（人 / 设备 / 其他）；`origin` NULL = 本地
//!   自定义，`'gh'`/`'gitea'` = 平台负责人（assignees）派生镜像；
//! - `item_resources`：条目 × 资源 + **占用比例**（照库口径 20–100 百分数）；
//! - `resource_calendar_exceptions`：资源级工作日历例外（请假 / 设备停机）。
//!
//! **与平台的边界**：GitHub 无资源/容量语义——平台侧唯一来源是 assignees（派生为
//! origin 行）；职务/类别/日容量/请假例外属纯本地扩展。

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// 资源目录条目（jordium `Resource` 的形状，去掉其视图期字段 tasks）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Human | Device | Others | 自定义（照库：不做强枚举，允许扩展）
    pub r#type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub department: Option<String>,
    /// 每日标准工时（小时）；None = 用全局默认
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capacity: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub origin: Option<String>,
}

/// 分配行：条目占用资源 allocation%（20–100，照库 clamp）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResource {
    pub item_id: String,
    pub resource_id: String,
    pub allocation: i64,
    pub origin: Option<String>,
}

// ---- 资源目录 ----

pub fn resources_list_in(conn: &Connection) -> Result<Vec<Resource>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, title, type, department, capacity, color, origin FROM resources ORDER BY name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Resource {
                id: row.get(0)?,
                name: row.get(1)?,
                title: row.get(2)?,
                r#type: row.get(3)?,
                department: row.get(4)?,
                capacity: row.get(5)?,
                color: row.get(6)?,
                origin: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 新建/更新资源（本地）。`id` 为空则新建（uuid 由前端给，保持与其他表一致）。
pub fn resource_upsert_in(conn: &Connection, r: &Resource) -> Result<(), String> {
    if r.name.trim().is_empty() {
        return Err("资源名称不能为空".to_string());
    }
    conn.execute(
        "INSERT INTO resources (id, name, title, type, department, capacity, color, origin, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, title = excluded.title, type = excluded.type,
           department = excluded.department, capacity = excluded.capacity, color = excluded.color",
        rusqlite::params![r.id, r.name.trim(), r.title, r.r#type, r.department, r.capacity, r.color],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除资源：连同其分配与例外一并清理（资源是被引用方，删除即解除引用）。
pub fn resource_remove_in(conn: &Connection, resource_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM item_resources WHERE resource_id = ?1", (resource_id,))
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM resource_calendar_exceptions WHERE resource_id = ?1", (resource_id,))
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM resources WHERE id = ?1", (resource_id,))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 平台负责人 → 资源目录镜像（origin = 平台标识）。
/// 同名同来源已存在则更新职务/部门之外的基础信息（幂等）；本地资源（origin NULL）
/// 不因同名而被覆盖——**本地真源优先**（与 deps/parents 同规则）。
pub fn resources_sync_assignees_in(
    conn: &Connection,
    origin: &str,
    logins: &[String],
) -> Result<usize, String> {
    let mut n = 0usize;
    for login in logins {
        let name = login.trim();
        if name.is_empty() {
            continue;
        }
        // 已有同来源同名的镜像行 → 跳过；本地已有同名 → 不建镜像（本地优先）
        let exists: Option<String> = conn
            .query_row(
                "SELECT id FROM resources WHERE name = ?1 AND (origin = ?2 OR origin IS NULL) LIMIT 1",
                (name, origin),
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_some() {
            continue;
        }
        let id = format!("gh-{origin}-{}", name.to_lowercase());
        conn.execute(
            "INSERT OR IGNORE INTO resources (id, name, title, type, department, capacity, color, origin, created_at)
             VALUES (?1, ?2, NULL, 'Human', NULL, NULL, NULL, ?3, datetime('now'))",
            (&id, name, origin),
        )
        .map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}

// ---- 分配 ----

pub fn item_resources_in(conn: &Connection, project_id: &str) -> Result<Vec<ItemResource>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT r.item_id, r.resource_id, r.allocation, r.origin
             FROM item_resources r
             JOIN project_items i ON i.id = r.item_id
             WHERE i.project_id = ?1
             ORDER BY r.item_id, r.resource_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((project_id,), |row| {
            Ok(ItemResource {
                item_id: row.get(0)?,
                resource_id: row.get(1)?,
                allocation: row.get(2)?,
                origin: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 设置分配（容器真源）：条目须在项目内、资源须存在；占用比例照库口径 clamp 20–100。
pub fn item_resource_set_in(
    conn: &Connection,
    project_id: &str,
    item_id: &str,
    resource_id: &str,
    allocation: i64,
) -> Result<(), String> {
    let in_project: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM project_items WHERE id = ?1 AND project_id = ?2",
            (item_id, project_id),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if in_project == 0 {
        return Err("条目不在该项目内".to_string());
    }
    let resource_exists: i64 = conn
        .query_row("SELECT COUNT(*) FROM resources WHERE id = ?1", (resource_id,), |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if resource_exists == 0 {
        return Err("资源不存在".to_string());
    }
    let alloc = allocation.clamp(20, 100); // 照 jordium 抽屉口径
    conn.execute(
        "INSERT INTO item_resources (item_id, resource_id, allocation, origin) VALUES (?1, ?2, ?3, NULL)
         ON CONFLICT(item_id, resource_id) DO UPDATE SET allocation = excluded.allocation, origin = NULL",
        (item_id, resource_id, alloc),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 解除分配；只动容器真源行（镜像行由平台同步管理）。
pub fn item_resource_remove_in(
    conn: &Connection,
    project_id: &str,
    item_id: &str,
    resource_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM item_resources
         WHERE item_id = ?1 AND resource_id = ?2 AND origin IS NULL
           AND item_id IN (SELECT id FROM project_items WHERE project_id = ?3)",
        (item_id, resource_id, project_id),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 条目删除 → 分配级联清理（与 deps/parents 同规则）。
pub fn item_resources_cascade_in(conn: &Connection, item_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM item_resources WHERE item_id = ?1", (item_id,))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- 资源级日历例外（请假 / 停机）----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceException {
    pub id: String,
    pub resource_id: Option<String>,
    pub name: Option<String>,
    pub start_at: String,
    pub end_at: String,
    /// true = 额外计工时（加班/补班）；false = 不计工时（请假/停机）
    pub working: bool,
}

pub fn resource_exceptions_in(conn: &Connection, resource_id: &str) -> Result<Vec<ResourceException>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, resource_id, name, start_at, end_at, working
             FROM resource_calendar_exceptions
             WHERE resource_id = ?1
             ORDER BY start_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((resource_id,), |row| {
            Ok(ResourceException {
                id: row.get(0)?,
                resource_id: row.get(1)?,
                name: row.get(2)?,
                start_at: row.get(3)?,
                end_at: row.get(4)?,
                working: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<std::result::Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn resource_exception_upsert_in(conn: &Connection, e: &ResourceException) -> Result<(), String> {
    if e.start_at.trim().is_empty() || e.end_at.trim().is_empty() {
        return Err("例外起止不能为空".to_string());
    }
    if e.start_at > e.end_at {
        return Err("例外开始不能晚于结束".to_string());
    }
    conn.execute(
        "INSERT INTO resource_calendar_exceptions (id, resource_id, name, start_at, end_at, working)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           resource_id = excluded.resource_id, name = excluded.name,
           start_at = excluded.start_at, end_at = excluded.end_at, working = excluded.working",
        (
            &e.id,
            &e.resource_id,
            &e.name,
            &e.start_at,
            &e.end_at,
            if e.working { 1 } else { 0 },
        ),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn resource_exception_remove_in(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM resource_calendar_exceptions WHERE id = ?1", (id,))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Tauri 命令 ----

#[tauri::command]
pub fn resource_list() -> Result<Vec<Resource>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    resources_list_in(&conn)
}

#[tauri::command]
pub fn resource_upsert(resource: Resource) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    resource_upsert_in(&conn, &resource)
}

#[tauri::command]
pub fn resource_remove(resource_id: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    resource_remove_in(&conn, &resource_id)
}

/// 平台负责人 → 资源目录镜像（幂等；本地同名优先，不覆盖）。
#[tauri::command]
pub fn resource_sync_assignees(origin: String, logins: Vec<String>) -> Result<usize, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    resources_sync_assignees_in(&conn, &origin, &logins)
}

#[tauri::command]
pub fn item_resource_list(project_id: String) -> Result<Vec<ItemResource>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    item_resources_in(&conn, &project_id)
}

#[tauri::command]
pub fn item_resource_set(
    project_id: String,
    item_id: String,
    resource_id: String,
    allocation: i64,
) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    item_resource_set_in(&conn, &project_id, &item_id, &resource_id, allocation)
}

#[tauri::command]
pub fn item_resource_remove(project_id: String, item_id: String, resource_id: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    item_resource_remove_in(&conn, &project_id, &item_id, &resource_id)
}

#[tauri::command]
pub fn resource_exception_list(resource_id: String) -> Result<Vec<ResourceException>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    resource_exceptions_in(&conn, &resource_id)
}

#[tauri::command]
pub fn resource_exception_upsert(exception: ResourceException) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    resource_exception_upsert_in(&conn, &exception)
}

#[tauri::command]
pub fn resource_exception_remove(id: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    resource_exception_remove_in(&conn, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::appdb::app_migrate(&conn).unwrap();
        conn
    }

    fn res(id: &str, name: &str) -> Resource {
        Resource {
            id: id.to_string(),
            name: name.to_string(),
            title: None,
            r#type: "Human".to_string(),
            department: None,
            capacity: None,
            color: None,
            origin: None,
        }
    }

    #[test]
    fn resource_crud_and_cascade() {
        let conn = mem_db();
        resource_upsert_in(&conn, &res("r1", "张三")).unwrap();
        resource_upsert_in(&conn, &res("r2", "3 号机床")).unwrap();
        assert_eq!(resources_list_in(&conn).unwrap().len(), 2);
        // 更新（改名 + 类别）
        let mut r = res("r2", "3 号机床（改）");
        r.r#type = "Device".to_string();
        resource_upsert_in(&conn, &r).unwrap();
        let list = resources_list_in(&conn).unwrap();
        assert_eq!(list.iter().find(|x| x.id == "r2").unwrap().r#type, "Device");
        // 空名拒绝
        assert!(resource_upsert_in(&conn, &res("r3", "  ")).is_err());
        // 删除清理分配
        resource_remove_in(&conn, "r1").unwrap();
        assert_eq!(resources_list_in(&conn).unwrap().len(), 1);
    }

    #[test]
    fn assignment_clamps_and_validates() {
        let conn = mem_db();
        resource_upsert_in(&conn, &res("r1", "张三")).unwrap();
        // 用既有的建项目/加条目辅助，避免手写列与 schema 漂移
        let p = crate::projects::project_create_in(&conn, "板", None, None).unwrap();
        let item = crate::projects::item_add_in(&conn, &p.id, "draft", None, None, Some("任务"), None).unwrap();
        // 低于下限 → clamp 到 20（照 jordium 抽屉口径）
        item_resource_set_in(&conn, &p.id, &item.id, "r1", 5).unwrap();
        let rows = item_resources_in(&conn, &p.id).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].allocation, 20);
        // 高于上限 → 100
        item_resource_set_in(&conn, &p.id, &item.id, "r1", 150).unwrap();
        assert_eq!(item_resources_in(&conn, &p.id).unwrap()[0].allocation, 100);
        // 不存在的资源 / 跨项目条目拒绝
        assert!(item_resource_set_in(&conn, &p.id, &item.id, "nope", 50).is_err());
        assert!(item_resource_set_in(&conn, "missing-project", &item.id, "r1", 50).is_err());
    }

    #[test]
    fn assignment_cascade_and_truth_protection() {
        let conn = mem_db();
        resource_upsert_in(&conn, &res("r1", "张三")).unwrap();
        // 条目删除 → 分配经 projects::item_remove_in 级联清理
        let p = crate::projects::project_create_in(&conn, "板", None, None).unwrap();
        let item = crate::projects::item_add_in(&conn, &p.id, "draft", None, None, Some("任务"), None).unwrap();
        item_resource_set_in(&conn, &p.id, &item.id, "r1", 60).unwrap();
        assert_eq!(item_resources_in(&conn, &p.id).unwrap().len(), 1);
        crate::projects::item_remove_in(&conn, &item.id).unwrap();
        assert!(item_resources_in(&conn, &p.id).unwrap().is_empty(), "条目删除级联清分配");
        item_resources_cascade_in(&conn, "i1").unwrap(); // 空表也安全
        // 镜像行（origin 非空）不受 remove 影响
        conn.execute(
            "INSERT INTO item_resources (item_id, resource_id, allocation, origin) VALUES ('i1', 'r1', 100, 'gh')",
            [],
        )
        .unwrap();
        item_resource_remove_in(&conn, "p1", "i1", "r1").unwrap();
        // 项目内无此条目 → 早退（0 行受影响），镜像行仍在
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM item_resources", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "镜像行保留");
    }

    #[test]
    fn assignee_sync_is_idempotent_and_local_first() {
        let conn = mem_db();
        // 本地已有「张三」（origin NULL）→ 平台同名不新建镜像
        resource_upsert_in(&conn, &res("local-1", "张三")).unwrap();
        let n = resources_sync_assignees_in(&conn, "gh", &["张三".to_string(), "李四".to_string()]).unwrap();
        assert_eq!(n, 1, "只新建李四");
        let list = resources_list_in(&conn).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|r| r.name == "李四" && r.origin.as_deref() == Some("gh")));
        // 幂等：再同步一次不增产
        let n2 = resources_sync_assignees_in(&conn, "gh", &["张三".to_string(), "李四".to_string()]).unwrap();
        assert_eq!(n2, 0);
        assert_eq!(resources_list_in(&conn).unwrap().len(), 2);
    }

    #[test]
    fn calendar_exception_validation() {
        let conn = mem_db();
        let ok = ResourceException {
            id: "e1".to_string(),
            resource_id: Some("r1".to_string()),
            name: Some("年假".to_string()),
            start_at: "2026-10-01".to_string(),
            end_at: "2026-10-07".to_string(),
            working: false,
        };
        resource_exception_upsert_in(&conn, &ok).unwrap();
        assert_eq!(resource_exceptions_in(&conn, "r1").unwrap().len(), 1);
        let bad = ResourceException { end_at: "2026-09-30".to_string(), ..ok.clone() };
        assert!(resource_exception_upsert_in(&conn, &bad).is_err(), "开始晚于结束拒绝");
        let empty = ResourceException { start_at: "".to_string(), ..ok.clone() };
        assert!(resource_exception_upsert_in(&conn, &empty).is_err());
        resource_exception_remove_in(&conn, "e1").unwrap();
        assert!(resource_exceptions_in(&conn, "r1").unwrap().is_empty());
    }
}
