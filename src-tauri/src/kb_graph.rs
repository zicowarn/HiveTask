//! 知识库图谱索引（KB《架构设计-知识库图谱》v1）——一次 invoke 返回全图。
//!
//! 纯派生数据：不落盘、不写任何文件（kb 根只读）。遍历 + 解析 + 组装全在
//! Rust 侧完成（先例：kb_walk 单命令返回全量，不逐文件 IPC）。
//!
//! 链接来源与消解（v1 口径，见设计篇 §3）：
//! - `[[wikilink]]`：`[[目标|别名]]` 取 `|` 前，`[[目标#小节]]` 取 `#` 前；
//!   图片类嵌入（![[x.png]]）跳过；
//! - 相对路径 Markdown 链接：`[t](./a.md)`、`[x](../up/b.md)`——http(s) /
//!   mailto / data / 纯锚点 / 非 md 扩展名忽略；
//! - 围栏代码块（``` / ~~~）与行内代码（`…`）不解析；
//! - 消解顺序：库根相对路径 → 源文件目录相对路径 → 文件名（不含扩展名）
//!   全库唯一。同名歧义与未命中不建边，进 `unresolved` 如实带回。

use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

use crate::kb;

/// md 节点上限（防巨库把 UI 拖死，与 kb_walk 的上限同理）。超限截断并置
/// `truncated`，前端如实提示。
const MAX_NODES: usize = 5000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphIndex {
    pub nodes: Vec<GraphNode>,
    pub links: Vec<GraphLink>,
    /// 有引用但库内无唯一对应文件（未建或同名歧义）——如实带回。
    pub unresolved: Vec<String>,
    /// md 文件数超上限，图为局部。
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    /// 唯一 id = 库内相对路径（正斜杠）。
    pub id: String,
    /// 首个 H1，缺省文件名去扩展名。
    pub title: String,
    /// 顶层目录（前端着色维度）；根下文件为 None。
    pub folder: Option<String>,
    /// 标签（frontmatter `tags:` + 行内 `#tag`，去重排序）——筛选维度。
    pub tags: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLink {
    pub source: String,
    pub target: String,
}

#[tauri::command]
pub fn kb_graph_index(root: String) -> Result<GraphIndex, String> {
    build_index(&root).map_err(|e| e.to_string())
}

// ---- 布局持久化（app.db prefs；设计篇 §5：坐标是用户视图偏好）----

/// FNV-1a 64：与 storage.rs 同款思路——自实现 10 行，不为指纹引 hash 依赖。
fn fnv1a64(data: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 布局键：`graph.layout.<root 规范路径指纹 16hex>`（root_path 已 canonicalize，
/// 等价路径同键；解析失败时退回原串，宁可共键不可崩）。
fn layout_key(root_str: &str) -> String {
    let canon = kb::root_path(root_str)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| root_str.to_string());
    format!("graph.layout.{:016x}", fnv1a64(&canon))
}

pub fn layout_get_in(conn: &Connection, root_str: &str) -> Result<Option<String>> {
    let value = conn
        .query_row(
            "SELECT value FROM prefs WHERE key = ?1",
            (layout_key(root_str),),
            |row| row.get(0),
        )
        .ok();
    Ok(value)
}

pub fn layout_set_in(conn: &Connection, root_str: &str, layout_json: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO prefs (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![layout_key(root_str), layout_json, crate::appdb::chrono_like_now()],
    )?;
    Ok(())
}

/// 读取记忆布局（JSON `{rel: [x, y]}`；无记录 → None）。
#[tauri::command]
pub fn kb_graph_layout_get(root: String) -> Result<Option<String>, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    layout_get_in(&conn, &root).map_err(|e| e.to_string())
}

/// 保存记忆布局（upsert；前端在拖拽结束与布局收敛后防抖调用）。
#[tauri::command]
pub fn kb_graph_layout_set(root: String, layout_json: String) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    layout_set_in(&conn, &root, &layout_json).map_err(|e| e.to_string())
}

pub fn build_index(root_str: &str) -> Result<GraphIndex> {
    let root = kb::root_path(root_str)?;
    // limit 走 kb_walk 默认护栏（20k）；md 子集再按 MAX_NODES 截断。
    let walked =
        kb::kb_walk(root_str.to_string(), None, None).map_err(anyhow::Error::msg)?;
    let md_all: Vec<String> = walked
        .into_iter()
        .map(|r| r.replace('\\', "/"))
        .filter(|r| is_markdown(r))
        .collect();
    let truncated = md_all.len() > MAX_NODES;
    let md_rels: Vec<String> = md_all.into_iter().take(MAX_NODES).collect();

    // 文件名（去扩展名）→ rel 列表；唯一才可作兜底消解。
    let rel_set: HashSet<String> = md_rels.iter().cloned().collect();
    let mut by_stem: HashMap<String, Vec<String>> = HashMap::new();
    for rel in &md_rels {
        by_stem.entry(file_stem(rel)).or_default().push(rel.clone());
    }

    let mut nodes = Vec::with_capacity(md_rels.len());
    let mut links: Vec<GraphLink> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut unresolved: Vec<String> = Vec::new();
    let mut unresolved_seen: HashSet<String> = HashSet::new();

    for rel in &md_rels {
        let Ok(bytes) = std::fs::read(root.join(rel)) else { continue };
        let (text, _, _) = kb::decode_bytes(&bytes);
        nodes.push(GraphNode {
            id: rel.clone(),
            title: first_heading(&text).unwrap_or_else(|| file_stem(rel)),
            folder: rel.split_once('/').map(|(f, _)| f.to_string()),
            tags: extract_tags(&text),
        });
        for raw in parse_targets(&text) {
            match resolve_target(&raw, rel, &by_stem, &rel_set) {
                Some(target) => {
                    if target != *rel && seen.insert((rel.clone(), target.clone())) {
                        links.push(GraphLink { source: rel.clone(), target });
                    }
                }
                None => {
                    if unresolved_seen.insert(raw.clone()) {
                        unresolved.push(raw);
                    }
                }
            }
        }
    }

    Ok(GraphIndex { nodes, links, unresolved, truncated })
}

fn is_markdown(rel: &str) -> bool {
    let lower = rel.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

fn file_stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((base, _)) if !base.is_empty() => base.to_string(),
        _ => name.to_string(),
    }
}

fn parent_dir(rel: &str) -> &str {
    match rel.rsplit_once('/') {
        Some((dir, _)) => dir,
        None => "",
    }
}

/// 相对路径归一：段级处理 `.` / `..`（越出根 → None）。
fn normalize_rel_path(dir: &str, target: &str) -> Option<String> {
    let mut stack: Vec<&str> = Vec::new();
    if !dir.is_empty() {
        stack.extend(dir.split('/'));
    }
    for seg in target.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop()?;
            }
            s => stack.push(s),
        }
    }
    Some(stack.join("/"))
}

// ---- 解析 ----

/// 提取全部链接目标（原始串，未消解）：wikilink + 相对 md 链接。
/// 围栏与行内代码跳过。
pub fn parse_targets(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fence: Option<char> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(marker) = fence_marker(trimmed) {
            match fence {
                None => fence = Some(marker),
                Some(open) if open == marker => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        let clean = strip_inline_code(trimmed);
        collect_wikilinks(&clean, &mut out);
        collect_md_links(&clean, &mut out);
    }
    out
}

/// 行首 3+ 个相同反引号/波浪线视为围栏开关。
fn fence_marker(line: &str) -> Option<char> {
    let c = line.chars().next()?;
    if (c == '`' || c == '~') && line.starts_with(&c.to_string().repeat(3)) {
        Some(c)
    } else {
        None
    }
}

/// 去掉行内代码段（成对反引号之间的内容）。
fn strip_inline_code(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_code = false;
    for c in line.chars() {
        if c == '`' {
            in_code = !in_code;
        } else if !in_code {
            out.push(c);
        }
    }
    out
}

fn collect_wikilinks(s: &str, out: &mut Vec<String>) {
    let mut rest = s;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else { break };
        let target = wikilink_target(&rest[..end]);
        if !target.is_empty() && !is_media_name(&target) {
            out.push(target);
        }
        rest = &rest[end + 2..];
    }
}

fn wikilink_target(inner: &str) -> String {
    let t = inner.split('|').next().unwrap_or("");
    let t = t.split('#').next().unwrap_or("");
    t.trim().to_string()
}

/// 嵌入目标带媒体类扩展名（![[x.png]]）——不是笔记，不进图谱。
fn is_media_name(target: &str) -> bool {
    let lower = target.to_lowercase();
    const MEDIA_EXTS: [&str; 10] =
        ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "pdf", "mp4", "mov"];
    lower
        .rsplit_once('.')
        .map(|(_, ext)| MEDIA_EXTS.contains(&ext))
        .unwrap_or(false)
}

fn collect_md_links(s: &str, out: &mut Vec<String>) {
    let mut rest = s;
    while let Some(pos) = rest.find("](") {
        rest = &rest[pos + 2..];
        let end = rest
            .find(|c: char| c == ')' || c.is_whitespace())
            .unwrap_or(rest.len());
        let raw = &rest[..end];
        let raw = raw.strip_prefix('<').and_then(|r| r.strip_suffix('>')).unwrap_or(raw);
        if is_md_link_target(raw) {
            out.push(raw.to_string());
        }
        rest = rest.get(end..).unwrap_or("");
    }
}

/// 只收相对 .md/.markdown 链接：远程 scheme、纯锚点、其他扩展名一概忽略。
fn is_md_link_target(raw: &str) -> bool {
    if raw.is_empty() || raw.starts_with('#') || raw.contains("://") {
        return false;
    }
    let lower = raw.to_lowercase();
    !lower.starts_with("mailto:")
        && !lower.starts_with("data:")
        && (lower.ends_with(".md") || lower.ends_with(".markdown"))
}

// ---- 消解 ----

/// 目标消解：库根相对（原样 / 补 .md）→ 源文件目录相对 → 文件名唯一兜底。
/// 歧义（同名多文件）与未命中 → None（调用方进 unresolved）。
fn resolve_target(
    raw: &str,
    from_rel: &str,
    by_stem: &HashMap<String, Vec<String>>,
    rel_set: &HashSet<String>,
) -> Option<String> {
    let t = raw.trim().trim_start_matches("./").replace('\\', "/");
    if t.is_empty() || t.starts_with('/') || t.contains(':') {
        return None;
    }
    let dir = parent_dir(from_rel);
    for candidate in [t.clone(), format!("{t}.md")] {
        if let Some(hit) = rel_set.get(&candidate) {
            return Some(hit.clone());
        }
        if let Some(joined) = normalize_rel_path(dir, &candidate) {
            if let Some(hit) = rel_set.get(&joined) {
                return Some(hit.clone());
            }
        }
    }
    match by_stem.get(&file_stem(&t)) {
        Some(v) if v.len() == 1 => Some(v[0].clone()),
        _ => None,
    }
}

/// 围栏外首个 `# ` 标题。
/// 标签提取：frontmatter `tags:`（`[a, b]` / `a, b` / `  - a` 列表）+ 行内
/// `#tag`（# 后非空白且非 #——排除标题；围栏与行内代码跳过）。去重排序。
fn extract_tags(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let push = |raw: &str, out: &mut Vec<String>| {
        let t = raw
            .trim()
            .trim_start_matches(['[', ' '])
            .trim_end_matches(']')
            .trim_matches(|c| c == '"' || c == '\'')
            .trim()
            .to_string();
        if !t.is_empty() && !t.contains(char::is_whitespace) && !out.contains(&t) {
            out.push(t);
        }
    };
    if let Some(fm) = frontmatter(text) {
        let mut in_tags = false;
        for line in fm.lines() {
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("tags:") {
                in_tags = true;
                let rest = rest.trim();
                if !rest.is_empty() {
                    for tag in rest.split(',') {
                        push(tag, &mut out);
                    }
                }
            } else if in_tags && (trimmed.starts_with("- ") || trimmed.starts_with("-\t")) {
                push(trimmed[1..].trim(), &mut out);
            } else if !trimmed.is_empty() {
                in_tags = false;
            }
        }
    }
    let mut fence: Option<char> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(marker) = fence_marker(trimmed) {
            match fence {
                None => fence = Some(marker),
                Some(open) if open == marker => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        let clean = strip_inline_code(trimmed);
        let chars: Vec<char> = clean.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let prev_ok =
                i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(' || chars[i - 1] == '（';
            if chars[i] == '#' && prev_ok && i + 1 < chars.len() && !chars[i + 1].is_whitespace() && chars[i + 1] != '#' {
                let start = i + 1;
                let mut j = start;
                while j < chars.len() && !is_tag_stop(chars[j]) {
                    j += 1;
                }
                let tag: String = chars[start..j].iter().collect();
                push(&tag, &mut out);
                i = j;
                continue;
            }
            i += 1;
        }
    }
    out.sort();
    out.dedup();
    out
}

/// 行内 `#tag` 的收尾字符（碰到即停，不进标签）。含全角标点——中文正文里
/// `#标签（说明…` 的全角括号必须断开，否则把半句吞进标签。
fn is_tag_stop(c: char) -> bool {
    c.is_whitespace()
        || "()[]{}.,;:!?#'\"|".contains(c)
        || "（）［］｛｝．，；：！？’”｜、。「」『』《》【】〈〉".contains(c)
}

/// 文首 frontmatter 块（`---` 行包围）；没有 → None。只认 `\n` 换行形态。
fn frontmatter(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

/// 围栏外首个 `# ` 标题。
fn first_heading(text: &str) -> Option<String> {
    let mut fence: Option<char> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(marker) = fence_marker(trimmed) {
            match fence {
                None => fence = Some(marker),
                Some(open) if open == marker => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("# ") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wikilink_forms_and_md_links() {
        let md = "# T\n[[Alpha]] [[Beta|别名]] [[Gamma#小节]] [[dir/Delta]]\n[x](./e.md) [y](../up/f.md) [z](g.markdown)\n";
        let targets = parse_targets(md);
        for expect in ["Alpha", "Beta", "Gamma", "dir/Delta", "./e.md", "../up/f.md", "g.markdown"] {
            assert!(targets.iter().any(|t| t == expect), "缺目标: {expect}");
        }
    }

    #[test]
    fn ignores_non_md_and_remote_links() {
        let md = "[z](https://e.com/a.md) [w](#anchor) [i](img.png) [m](mailto:a@b.c) [[img.png]] [[#小节]]\n";
        assert!(parse_targets(md).is_empty());
    }

    #[test]
    fn skips_code_fences_and_inline_code() {
        let md = "```\n[[Nope]] [x](a.md)\n```\n文字 `[[Inline]]` 与 `[y](b.md)`\n~~~\n[[Tilde]]\n~~~\n[[Yes]]\n";
        let targets = parse_targets(md);
        assert!(targets.iter().any(|t| t == "Yes"));
        for absent in ["Nope", "Inline", "Tilde"] {
            assert!(!targets.iter().any(|t| t == absent), "不该出现: {absent}");
        }
        assert!(!targets.iter().any(|t| t.ends_with("a.md")));
        assert!(!targets.iter().any(|t| t.ends_with("b.md")));
    }

    #[test]
    fn resolves_by_path_then_unique_stem() {
        let rel_set: HashSet<String> =
            ["a.md", "dir/b.md", "dir/sub/c.md", "one/amb.md", "two/amb.md"]
                .iter()
                .map(|s| s.to_string())
                .collect();
        let mut by_stem: HashMap<String, Vec<String>> = HashMap::new();
        for rel in &rel_set {
            by_stem.entry(file_stem(rel)).or_default().push(rel.clone());
        }

        // 库根相对
        assert_eq!(
            resolve_target("dir/b.md", "a.md", &by_stem, &rel_set),
            Some("dir/b.md".to_string())
        );
        assert_eq!(
            resolve_target("dir/b", "a.md", &by_stem, &rel_set),
            Some("dir/b.md".to_string())
        );
        // 源文件目录相对（markdown 常规语义）
        assert_eq!(
            resolve_target("./c.md", "dir/b.md", &by_stem, &rel_set),
            Some("dir/sub/c.md".to_string())
        );
        assert_eq!(
            resolve_target("../b.md", "dir/sub/c.md", &by_stem, &rel_set),
            Some("dir/b.md".to_string())
        );
        // 文件名唯一兜底（wikilink 语义）
        assert_eq!(
            resolve_target("c", "a.md", &by_stem, &rel_set),
            Some("dir/sub/c.md".to_string())
        );
        // 同名歧义与未命中
        assert_eq!(resolve_target("amb", "a.md", &by_stem, &rel_set), None);
        assert_eq!(resolve_target("ghost", "a.md", &by_stem, &rel_set), None);
        // 越出根
        assert_eq!(
            resolve_target("../../x.md", "dir/sub/c.md", &by_stem, &rel_set),
            None
        );
    }

    #[test]
    fn build_index_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::write(p.join("a.md"), "# 甲篇\n\n看 [[b]] 和 [详](sub/c.md)\n").unwrap();
        std::fs::write(p.join("b.md"), "互链 [[a]]，幽灵 [[ghost]]，自链 [[b]]\n").unwrap();
        std::fs::create_dir(p.join("sub")).unwrap();
        std::fs::write(p.join("sub/c.md"), "叶子，无链接\n").unwrap();

        let idx = build_index(p.to_str().unwrap()).unwrap();
        assert_eq!(idx.nodes.len(), 3);
        assert_eq!(idx.links.len(), 3); // a→b、a→sub/c、b→a（自链不计）
        assert!(idx.unresolved.iter().any(|u| u == "ghost"));
        assert!(!idx.truncated);

        let a = idx.nodes.iter().find(|n| n.id == "a.md").unwrap();
        assert_eq!(a.title, "甲篇");
        let c = idx.nodes.iter().find(|n| n.id == "sub/c.md").unwrap();
        assert_eq!(c.folder.as_deref(), Some("sub"));
    }

    #[test]
    fn layout_prefs_roundtrip_and_key_stability() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)",
            [],
        )
        .unwrap();
        assert!(layout_get_in(&conn, "/tmp/任意根").unwrap().is_none());
        layout_set_in(&conn, "/tmp/任意根", "{\"a.md\":[1.5,2.5]}").unwrap();
        assert_eq!(
            layout_get_in(&conn, "/tmp/任意根").unwrap().as_deref(),
            Some("{\"a.md\":[1.5,2.5]}")
        );
        // upsert 覆盖
        layout_set_in(&conn, "/tmp/任意根", "{\"a.md\":[9.0,9.0]}").unwrap();
        assert_eq!(
            layout_get_in(&conn, "/tmp/任意根").unwrap().as_deref(),
            Some("{\"a.md\":[9.0,9.0]}")
        );
        // 不同根不同键
        assert!(layout_get_in(&conn, "/tmp/另一个根").unwrap().is_none());
        // 键对等价输入稳定（同串 → 同键）
        assert_eq!(layout_key("/tmp/x"), layout_key("/tmp/x"));
    }

    #[test]
    fn extracts_tags_from_frontmatter_and_inline() {
        let md = "---\ntags: [alpha, beta]\nother: x\n---\n# 标题不是标签\n正文 #gamma 与 #delta（#epsilon）\n```\n#fence_not_tag\n```\n`#inline_not_tag`\n中文标签 #项目/管理\n";
        let tags = extract_tags(md);
        for expect in ["alpha", "beta", "gamma", "delta", "epsilon"] {
            assert!(tags.contains(&expect.to_string()), "缺标签: {expect}");
        }
        assert!(!tags.contains(&"fence_not_tag".to_string()));
        assert!(!tags.contains(&"inline_not_tag".to_string()));
        assert!(!tags.contains(&"标题不是标签".to_string()));
        assert!(tags.contains(&"项目/管理".to_string())); // 斜杠是合法标签字符
    }

    #[test]
    fn extracts_tags_from_frontmatter_list_form() {
        let md = "---\ntags:\n  - one\n  - two\n---\nbody\n";
        let tags = extract_tags(md);
        assert_eq!(tags, vec!["one".to_string(), "two".to_string()]);
    }

    #[test]
    fn decodes_gbk_sources() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::write(p.join("b.md"), "# 乙\n").unwrap();
        // GB18030 编码的 md：wikilink 也必须解析得出（编码保真走 decode_bytes）
        let (gb, _, _) = encoding_rs::GB18030.encode("[[b]] 中文内容");
        std::fs::write(p.join("a.md"), gb.as_ref()).unwrap();

        let idx = build_index(p.to_str().unwrap()).unwrap();
        assert!(idx.links.iter().any(|l| l.source == "a.md" && l.target == "b.md"));
    }
}
