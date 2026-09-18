//! 日历图层（S3-b，知识库《架构设计-日历面板》§5–§7）：
//! - ICS 订阅（`calendar_feeds`，app_008）：拉取/解析/缓存进库；断网读缓存；
//!   跨度事件（DTEND/DURATION）按日展开，DTEND 为**排他端点**（RFC 5545），
//!   上限 62 天/事件；RRULE v1 仍只取 DTSTART 首次（做半套 BY* 更危险）；
//!   法定假日亦走订阅（内置 holiday-cn 层已于 2026-09-18 经用户定案移除）；
//! - 农历日格副行：chinese-lunisolar-calendar（MIT），初一显示月名、其余日名。
//!
//! 红线：订阅 URL 属准凭据——任何错误信息**不得包含完整 URL**（reqwest 的
//! 错误 Display 会带 URL，必须 map_err 剥离）。

use anyhow::{anyhow, Result};
use chinese_lunisolar_calendar::{LunisolarDate, SolarDate};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::appdb;

// ============ 农历日格副行 ============

/// 农历标签：初一 → 月名（含「闰」前缀），其余 → 日名。简体变体。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LunarLabel {
    pub date: String,
    pub text: String,
}

/// 闭区间 [start, end] 的农历标签。范围上限 800 天（月视图导航足够）。
pub fn lunar_range(start: &str, end: &str) -> Result<Vec<LunarLabel>> {
    let (sy, sm, sd) = parse_ymd(start).ok_or_else(|| anyhow!("起始日期格式应为 YYYY-MM-DD"))?;
    let (ey, em, ed) = parse_ymd(end).ok_or_else(|| anyhow!("结束日期格式应为 YYYY-MM-DD"))?;
    let mut s = (sy, sm, sd);
    let e = (ey, em, ed);
    let mut out = Vec::new();
    let mut guard = 0;
    while s <= e {
        guard += 1;
        if guard > 800 {
            return Err(anyhow!("日期范围过大（上限 800 天）"));
        }
        let (y, m, d) = s;
        let solar = SolarDate::from_ymd(y as u16, m as u8, d as u8)
            .map_err(|_| anyhow!("日期 {y:04}-{m:02}-{d:02} 超出农历支持范围（1901–2101）"))?;
        let lunisolar = LunisolarDate::from_solar_date(solar)
            .map_err(|_| anyhow!("农历转换失败：{y:04}-{m:02}-{d:02}"))?;
        // `{:#}` = 简体变体（臘月→腊月）；枚举 Display 兜底再替换一次，双保险。
        let month_text = format!("{:#}", lunisolar.to_lunar_month()).replace('臘', "腊").replace('閏', "闰");
        let day_text = format!("{:#}", lunisolar.to_lunar_day());
        let text = if day_text == "初一" { month_text } else { day_text };
        out.push(LunarLabel {
            date: format!("{y:04}-{m:02}-{d:02}"),
            text,
        });
        s = next_day(s);
    }
    Ok(out)
}

/// 日期串 +n 天（跨度展开用）。
fn date_add_days(s: &str, n: u32) -> Option<String> {
    let (mut y, mut m, mut d) = parse_ymd(s)?;
    for _ in 0..n {
        (y, m, d) = next_day((y, m, d));
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// 日期串 +1 天。
fn next_date_str(s: &str) -> Option<String> {
    let (y, m, d) = parse_ymd(s)?;
    let (y, m, d) = next_day((y, m, d));
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// DURATION 最小解析：P[n]W / P[n]D（可组合），时间部分（T 之后）忽略——
/// date 级日历不需要小时精度。
fn parse_duration_days(value: &str) -> Option<u32> {
    let upper = value.trim().to_uppercase();
    let body = upper.strip_prefix('P')?;
    let date_part = body.split('T').next()?;
    let mut days = 0u32;
    let mut num = String::new();
    for ch in date_part.chars() {
        if ch.is_ascii_digit() {
            num.push(ch);
        } else {
            let n: u32 = num.parse().ok()?;
            num.clear();
            match ch {
                'W' => days += n * 7,
                'D' => days += n,
                _ => return None,
            }
        }
    }
    Some(days).filter(|d| *d > 0)
}

/// YYYY-MM-DD → (y, m, d)；格式不符返回 None。
fn parse_ymd(s: &str) -> Option<(i32, u32, u32)> {
    let mut it = s.split('-');
    let y: i32 = it.next()?.parse().ok()?;
    let m: u32 = it.next()?.parse().ok()?;
    let d: u32 = it.next()?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

/// 公历下一日（按 (y,m,d) 元组递增，月份天数用固定表——农历标签用途够准，
/// 且 crate 的转换才是权威，这里只负责遍历）。
fn next_day((y, m, d): (i32, u32, u32)) -> (i32, u32, u32) {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    let last: u32 = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
    };
    if d < last {
        (y, m, d + 1)
    } else {
        (ny, nm, 1)
    }
}

// ============ ICS 解析（RFC 5545 最小面） ============

/// ICS 事件（订阅缓存的最小形状）。RRULE 重复规则 v1 刻意不支持：
/// 只取 DTSTART 首次发生（文档化口径，重复事件多出现于 Google 私密地址）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IcsEvent {
    /// YYYY-MM-DD（DTSTART 归日；VALUE=DATE 直取，date-time 取本地日期部分）。
    pub date: String,
    pub title: String,
}

/// 行展开（RFC 5545 §3.1：CRLF 后跟空格/制表符为续行）。
fn unfold_ics(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in text.split(['\n', '\r']) {
        if raw.is_empty() {
            continue;
        }
        if (raw.starts_with(' ') || raw.starts_with('\t')) && !out.is_empty() {
            let last = out.last_mut().expect("out 非空已由分支守卫");
            last.push_str(&raw[1..]);
        } else {
            out.push(raw.to_string());
        }
    }
    out
}

/// 拆属性行 `NAME;PARAM=V;PARAM="V":value`——冒号在双引号参数值内不算分隔符。
fn split_property(line: &str) -> Option<(String, Vec<String>, String)> {
    let bytes = line.as_bytes();
    let mut in_quotes = false;
    let mut colon = None;
    for (i, b) in bytes.iter().enumerate() {
        match b {
            b'"' => in_quotes = !in_quotes,
            b':' if !in_quotes => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let idx = colon?;
    let head = &line[..idx];
    let value = line[idx + 1..].to_string();
    let mut parts = head.split(';');
    let name = parts.next()?.trim().to_uppercase();
    let params = parts.map(|p| p.trim().to_uppercase()).collect();
    Some((name, params, value))
}

/// DTSTART 值 → YYYY-MM-DD。VALUE=DATE 直取；date-time（可带 Z / TZID 参数）
/// 取前 8 位本地日期部分。
fn ics_date_of(params: &[String], value: &str) -> Option<String> {
    let digits: String = value.chars().take(8).filter(|c| c.is_ascii_digit()).collect();
    let _ = params;
    if digits.len() != 8 {
        return None;
    }
    let y: u32 = digits[0..4].parse().ok()?;
    let m: u32 = digits[4..6].parse().ok()?;
    let d: u32 = digits[6..8].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// ICS 文本转义解码（RFC 5545 §3.3.11）。
fn unescape_ics_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push('\n'),
                Some(',') => out.push(','),
                Some(';') => out.push(';'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 解析 ICS 文本为事件列表（按日期升序）。缺 DTSTART 的事件跳过。
pub fn parse_ics(text: &str) -> Vec<IcsEvent> {
    let mut events: Vec<IcsEvent> = Vec::new();
    let mut in_event = false;
    let mut dtstart: Option<String> = None;
    let mut summary: Option<String> = None;
    let mut dtend: Option<String> = None;
    // date-time 端点且结束时刻非零点（占用端点日）；VALUE=DATE 恒 false
    let mut dtend_time_nonzero = false;
    let mut duration_days: Option<u32> = None;
    for line in unfold_ics(text) {
        match line.as_str() {
            "BEGIN:VEVENT" => {
                in_event = true;
                dtstart = None;
                summary = None;
                dtend = None;
                dtend_time_nonzero = false;
                duration_days = None;
            }
            "END:VEVENT" => {
                if in_event {
                    if let Some(start) = dtstart.take() {
                        // 跨度展开：DTEND（排他）优先，其次 DURATION；同日/倒挂回落单日
                        let end_excl: Option<String> = dtend
                            .take()
                            .filter(|e| e.as_str() > start.as_str())
                            .map(|e| {
                                // 跨日的 date-time 端点：结束时刻非零点 → 端点日仍被占用
                                // （端点 +1 天后仍按排他日处理）；零点结束 / VALUE=DATE 不动
                                if dtend_time_nonzero {
                                    date_add_days(&e, 1).unwrap_or(e)
                                } else {
                                    e
                                }
                            })
                            .or_else(|| {
                                duration_days
                                    .and_then(|n| date_add_days(&start, n))
                                    .filter(|e| e.as_str() > start.as_str())
                            });
                        let mut cursor = start;
                        let mut guard = 0u32; // 62 天上限：防异常源刷屏
                        loop {
                            // 先查排他端点再推送（推进到端点日即止）
                            if let Some(e) = end_excl.as_deref() {
                                if cursor.as_str() >= e {
                                    break;
                                }
                            }
                            if guard >= 62 {
                                break;
                            }
                            events.push(IcsEvent {
                                date: cursor.clone(),
                                title: summary.clone().unwrap_or_default(),
                            });
                            guard += 1;
                            if end_excl.is_none() {
                                break; // 无跨度 = 单日
                            }
                            match next_date_str(&cursor) {
                                Some(n) => cursor = n,
                                None => break,
                            }
                        }
                    }
                }
                in_event = false;
            }
            _ if in_event => {
                if let Some((name, params, value)) = split_property(&line) {
                    match name.as_str() {
                        "DTSTART" => dtstart = ics_date_of(&params, &value),
                        "DTEND" => {
                            dtend = ics_date_of(&params, &value);
                            dtend_time_nonzero = !params.iter().any(|p| p == "VALUE=DATE") && {
                                let time_digits: String = value
                                    .chars()
                                    .skip(8)
                                    .take(6)
                                    .filter(|c| c.is_ascii_digit())
                                    .collect();
                                !time_digits.is_empty() && time_digits != "000000"
                            };
                        }
                        "DURATION" => duration_days = parse_duration_days(&value),
                        "SUMMARY" => summary = Some(unescape_ics_text(&value)),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    events.sort_by(|a, b| a.date.cmp(&b.date));
    events
}

// ============ 订阅 CRUD / 拉取 / 事件（calendar_feeds，app_008） ============

/// 订阅行（列表/管理 UI 用）。url 仅回显给添加者，不经日志。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedRow {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    pub last_synced_at: Option<String>,
    /// 缓存事件数；None = 从未同步。
    pub cached_count: Option<u32>,
    /// 事件色 #RRGGBB；None = 默认样式（accent 实底 + 虚线描边）。
    pub color: Option<String>,
}

/// 订阅事件（跨启用的订阅聚合，前端日历图层用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedEvent {
    pub feed_id: String,
    pub feed_name: String,
    pub date: String,
    pub title: String,
}

fn feed_row_on(conn: &Connection, id: &str) -> Result<FeedRow> {
    conn.query_row(
        "SELECT id, name, url, enabled, last_synced_at, cached_payload, color FROM calendar_feeds WHERE id = ?1",
        [id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        },
    )
    .optional()?
    .map(|(id, name, url, enabled, last_synced_at, payload, color)| FeedRow {
        id,
        name,
        url,
        enabled: enabled != 0,
        last_synced_at,
        cached_count: payload.and_then(|p| serde_json::from_str::<Vec<IcsEvent>>(&p).ok().map(|v| v.len() as u32)),
        color,
    })
    .ok_or_else(|| anyhow!("订阅不存在"))
}

pub fn feed_list() -> Result<Vec<FeedRow>> {
    let conn = appdb::open()?;
    feed_list_on(&conn)
}

pub fn feed_list_on(conn: &Connection) -> Result<Vec<FeedRow>> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM calendar_feeds ORDER BY rowid")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    ids.iter().map(|id| feed_row_on(conn, id)).collect()
}

pub fn feed_add(name: &str, url: &str) -> Result<FeedRow> {
    let conn = appdb::open()?;
    feed_add_on(&conn, name, url)
}

pub fn feed_add_on(conn: &Connection, name: &str, url: &str) -> Result<FeedRow> {
    let name = name.trim();
    let url = url.trim();
    if name.is_empty() {
        return Err(anyhow!("名称不能为空"));
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(anyhow!("订阅地址须为 http(s) URL"));
    }
    let id = appdb::uuid();
    conn.execute(
        "INSERT INTO calendar_feeds (id, name, url, enabled) VALUES (?1, ?2, ?3, 1)",
        rusqlite::params![id, name, url],
    )?;
    feed_row_on(conn, &id)
}

pub fn feed_remove(id: &str) -> Result<()> {
    let conn = appdb::open()?;
    feed_remove_on(&conn, id)
}

pub fn feed_remove_on(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM calendar_feeds WHERE id = ?1", [id])?;
    Ok(())
}

pub fn feed_set_enabled(id: &str, enabled: bool) -> Result<FeedRow> {
    let conn = appdb::open()?;
    feed_set_enabled_on(&conn, id, enabled)
}

pub fn feed_set_color(id: &str, color: Option<String>) -> Result<FeedRow> {
    let conn = appdb::open()?;
    feed_set_color_on(&conn, id, color)
}

pub fn feed_set_color_on(conn: &Connection, id: &str, color: Option<String>) -> Result<FeedRow> {
    let normalized = match color.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(c) => {
            let body = c.strip_prefix('#').ok_or_else(|| anyhow!("颜色须为 #RGB 或 #RRGGBB"))?;
            let ok = (body.len() == 3 || body.len() == 6)
                && body.chars().all(|ch| ch.is_ascii_hexdigit());
            if !ok {
                return Err(anyhow!("颜色须为 #RGB 或 #RRGGBB"));
            }
            Some(format!("#{}", body.to_ascii_uppercase()))
        }
    };
    conn.execute(
        "UPDATE calendar_feeds SET color = ?2 WHERE id = ?1",
        rusqlite::params![id, normalized],
    )?;
    feed_row_on(conn, id)
}

pub fn feed_set_enabled_on(conn: &Connection, id: &str, enabled: bool) -> Result<FeedRow> {
    conn.execute(
        "UPDATE calendar_feeds SET enabled = ?2 WHERE id = ?1",
        rusqlite::params![id, i64::from(enabled)],
    )?;
    feed_row_on(conn, id)
}

/// 拉取并刷新缓存。**URL 不进任何错误信息**（reqwest 错误 Display 会带 URL，
/// 必须在此剥离为无 URL 的描述）。
pub fn feed_sync(id: &str) -> Result<u32> {
    let conn = appdb::open()?;
    let url: String = conn
        .query_row("SELECT url FROM calendar_feeds WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or_else(|| anyhow!("订阅不存在"))?;
    let events = fetch_ics(&url)?;
    let n = events.len() as u32;
    let payload = serde_json::to_string(&events)?;
    conn.execute(
        "UPDATE calendar_feeds SET cached_payload = ?1, last_synced_at = datetime('now') WHERE id = ?2",
        rusqlite::params![payload, id],
    )?;
    Ok(n)
}

fn fetch_ics(url: &str) -> Result<Vec<IcsEvent>> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent(format!("hivetask/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| anyhow!("订阅拉取失败：客户端初始化失败"))?;
    let resp = client
        .get(url)
        .send()
        .map_err(|_| anyhow!("订阅拉取失败：网络错误或地址不可达"))?;
    let status = resp.status();
    let resp = resp
        .error_for_status()
        .map_err(|_| anyhow!("订阅拉取失败：HTTP {status}"))?;
    let text = resp
        .text()
        .map_err(|_| anyhow!("订阅拉取失败：响应读取失败"))?;
    Ok(parse_ics(&text))
}

/// 全部启用订阅的缓存事件聚合（断网可用；从未同步的订阅无事件）。
pub fn feed_events() -> Result<Vec<FeedEvent>> {
    let conn = appdb::open()?;
    feed_events_on(&conn)
}

pub fn feed_events_on(conn: &Connection) -> Result<Vec<FeedEvent>> {
    let mut out: Vec<FeedEvent> = Vec::new();
    let rows: Vec<(String, String, Option<String>)> = {
        let mut stmt = conn
            .prepare("SELECT id, name, cached_payload FROM calendar_feeds WHERE enabled = 1")?;
        let mapped = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (feed_id, feed_name, payload) in rows {
        let Some(payload) = payload else { continue };
        let events: Vec<IcsEvent> = match serde_json::from_str(&payload) {
            Ok(v) => v,
            Err(_) => continue, // 缓存损坏诚实跳过该订阅，不拖垮整体
        };
        for e in events {
            out.push(FeedEvent {
                feed_id: feed_id.clone(),
                feed_name: feed_name.clone(),
                date: e.date,
                title: e.title,
            });
        }
    }
    out.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ics_folding_date_forms_escapes_and_spans() {
        let ics = "BEGIN:VCALENDAR\r\n"
            .to_string()
            + "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260501\r\nSUMMARY:劳动节\r\nEND:VEVENT\r\n"
            + "BEGIN:VEVENT\r\nDTSTART:20260701T08000\r\n0Z\r\nSUMMARY:带时区的时间事件\r\nEND:VEVENT\r\n"
            + "BEGIN:VEVENT\r\nDTSTART;TZID=\"Asia/Shanghai\":20260801T090000\r\nSUMMARY:转义\\,测试\\;完成\\\\尾\r\nEND:VEVENT\r\n"
            + "BEGIN:VEVENT\r\nRRULE:FREQ=WEEKLY\r\nDTSTART;VALUE=DATE:20260901\r\nSUMMARY:重复事件仅首次\r\nEND:VEVENT\r\n"
            + "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261008\r\nSUMMARY:休｜国庆节\r\nEND:VEVENT\r\n"
            + "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20260619\r\nDURATION:P2D\r\nSUMMARY:端午跨度\r\nEND:VEVENT\r\n"
            + "BEGIN:VEVENT\r\nDTSTART:20260801T230000\r\nDTEND:20260802T010000\r\nSUMMARY:跨午夜时间事件\r\nEND:VEVENT\r\n"
            + "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261101\r\nSUMMARY:同日DTEND单日\r\nEND:VEVENT\r\n"
            + "BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261201\r\nDTEND;VALUE=DATE:20261130\r\nSUMMARY:倒挂DTEND单日\r\nEND:VEVENT\r\n"
            + "BEGIN:VEVENT\r\nSUMMARY:缺 DTSTART 应跳过\r\nEND:VEVENT\r\n"
            + "END:VCALENDAR\r\n";
        let events = parse_ics(&ics);
        let count_on = |d: &str| events.iter().filter(|e| e.date == d).count();
        assert_eq!(count_on("2026-05-01"), 1);
        assert_eq!(count_on("2026-07-01"), 1, "date-time 折行取本地日期部分");
        assert_eq!(count_on("2026-08-01"), 2, "转义事件 + 跨午夜事件首日");
        assert_eq!(
            events
                .iter()
                .find(|e| e.date == "2026-08-01" && e.title.starts_with("转义"))
                .unwrap()
                .title,
            "转义,测试;完成\\尾"
        );
        assert_eq!(count_on("2026-09-01"), 1);
        assert_eq!(count_on("2026-09-08"), 0, "RRULE 不展开（v1 口径）");
        for d in [
            "2026-10-01",
            "2026-10-02",
            "2026-10-03",
            "2026-10-04",
            "2026-10-05",
            "2026-10-06",
            "2026-10-07",
        ] {
            assert_eq!(count_on(d), 1, "{d} 应有国庆");
        }
        assert_eq!(count_on("2026-10-08"), 0, "DTEND 排他，不落端点日");
        assert!(
            events
                .iter()
                .filter(|e| e.date.starts_with("2026-10-"))
                .all(|e| e.title == "休｜国庆节")
        );
        assert_eq!(count_on("2026-06-19"), 1);
        assert_eq!(count_on("2026-06-20"), 1);
        assert_eq!(count_on("2026-06-21"), 0);
        assert_eq!(count_on("2026-08-02"), 1, "跨午夜时间事件次日");
        assert_eq!(count_on("2026-11-01"), 1, "同日 DTEND 单日");
        assert_eq!(count_on("2026-12-01"), 1, "倒挂 DTEND 单日");
        assert!(events.windows(2).all(|w| w[0].date <= w[1].date));
    }

    #[test]
    fn lunar_known_anchors_and_leap_month() {
        // 春节（正月初一）多年锚点——初一是朔日，天文确定，逐年可公开核对
        for (date, _y) in [
            ("2024-02-10", 2024),
            ("2025-01-29", 2025),
            ("2026-02-17", 2026),
            ("2027-02-06", 2027),
            ("2028-01-26", 2028),
        ] {
            let rows = lunar_range(date, date).unwrap();
            assert_eq!(rows[0].text, "正月", "春节锚点 {date} 应显示月名 正月");
        }
        // 中秋（八月十五）多年锚点
        for date in ["2024-09-17", "2025-10-06", "2026-09-25"] {
            let rows = lunar_range(date, date).unwrap();
            assert_eq!(rows[0].text, "十五", "中秋锚点 {date} 应显示 十五");
        }
        // 交叉印证（2026-09-18，与用户订阅源比对）：节气 ICS 秋分=09-23、
        // 假日 ICS 中秋=09-25 → 三源一致推出 09-23=十三、09-22=十二
        assert_eq!(lunar_range("2026-09-23", "2026-09-23").unwrap()[0].text, "十三");
        assert_eq!(lunar_range("2026-09-22", "2026-09-22").unwrap()[0].text, "十二");
        // 2025 年有闰六月：窗口内应出现「闰」开头的月名（初一）或日名——月名必现
        let leap = lunar_range("2025-07-20", "2025-08-15").unwrap();
        assert!(
            leap.iter().any(|l| l.text.starts_with("闰")),
            "2025 闰六月应出现：{:?}",
            leap.iter().map(|l| (l.date.as_str(), l.text.as_str())).collect::<Vec<_>>()
        );
        // 跨年遍历边界：12-31 → 01-01
        let cross = lunar_range("2026-12-31", "2027-01-01").unwrap();
        assert_eq!(cross.len(), 2);
        assert_eq!(cross[0].date, "2026-12-31");
        assert_eq!(cross[1].date, "2027-01-01");
    }

    #[test]
    fn feed_crud_and_events_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        appdb::app_migrate(&conn).unwrap();
        let feed = feed_add_on(&conn, "我的日历", "https://example.com/cal.ics").unwrap();
        assert!(feed.enabled);
        assert_eq!(feed.cached_count, None);

        // 未同步 → 无事件
        assert!(feed_events_on(&conn).unwrap().is_empty());

        // 写缓存 → 事件聚合
        let events = vec![IcsEvent {
            date: "2026-10-01".into(),
            title: "国庆".into(),
        }];
        conn.execute(
            "UPDATE calendar_feeds SET cached_payload = ?1, last_synced_at = '2026-09-18T00:00:00Z' WHERE id = ?2",
            rusqlite::params![serde_json::to_string(&events).unwrap(), feed.id],
        )
        .unwrap();
        let rows = feed_events_on(&conn).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].feed_id, feed.id);
        assert_eq!(rows[0].feed_name, "我的日历");
        assert_eq!(rows[0].title, "国庆");

        // 禁用 → 事件不再聚合；列表 cached_count 有值
        feed_set_enabled_on(&conn, &feed.id, false).unwrap();
        assert!(feed_events_on(&conn).unwrap().is_empty());
        let listed = feed_list_on(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].enabled);
        assert_eq!(listed[0].cached_count, Some(1));

        // 颜色：合法值归一大写；非法值拒绝；None 清除
        let colored = feed_set_color_on(&conn, &feed.id, Some("#3fb950".to_string())).unwrap();
        assert_eq!(colored.color.as_deref(), Some("#3FB950"));
        let short = feed_set_color_on(&conn, &feed.id, Some("#abc".to_string())).unwrap();
        assert_eq!(short.color.as_deref(), Some("#ABC"));
        assert!(feed_set_color_on(&conn, &feed.id, Some("green".to_string())).is_err());
        assert!(feed_set_color_on(&conn, &feed.id, Some("#12345".to_string())).is_err());
        let cleared = feed_set_color_on(&conn, &feed.id, None).unwrap();
        assert_eq!(cleared.color, None);

        feed_remove_on(&conn, &feed.id).unwrap();
        assert!(feed_list_on(&conn).unwrap().is_empty());
    }

    #[test]
    #[ignore = "真实网络拉取：cargo test -- --ignored"]
    fn live_chinacalendar_2026_expands_full_spans() {
        let text = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap()
            .get("https://chinacalendar.app/ics/china-calendar-2026.ics")
            .send()
            .unwrap()
            .error_for_status()
            .unwrap()
            .text()
            .unwrap();
        let events = parse_ics(&text);
        assert!(
            events.len() >= 35,
            "2026 应逐日展开约 39 条（33 休 + 6 班）：{}",
            events.len()
        );
        for d in ["2026-10-01", "2026-10-04", "2026-10-07"] {
            assert!(
                events.iter().any(|e| e.date == d && e.title.contains("国庆")),
                "{d} 缺国庆（跨度未展开？）"
            );
        }
        assert!(events.iter().any(|e| e.date == "2026-02-15" && e.title.contains("春节")));
    }

    #[test]
    fn feed_add_rejects_bad_url_and_empty_name() {
        let conn = Connection::open_in_memory().unwrap();
        appdb::app_migrate(&conn).unwrap();
        assert!(feed_add_on(&conn, "", "https://example.com/a.ics").is_err());
        assert!(feed_add_on(&conn, "x", "ftp://example.com/a.ics").is_err());
        assert!(feed_add_on(&conn, "ok", "https://example.com/a.ics").is_ok());
    }
}
