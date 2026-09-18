//! 知识库文件系统层：浏览 / 读取 / 写入用户选定的知识库根目录。
//!
//! 不引 `tauri-plugin-fs`——它的权限面对桌面应用过大，且给不了这里要的三件事：
//! ① **根沙箱**：canonicalize + 前缀校验，拒绝 `..`、绝对路径与符号链接逃逸；
//! ② **编码保真**：chardetng 探测 + encoding_rs 解码，写回按原编码（中文遗留文件多为 GBK）；
//! ③ **排除/忽略规则**：内置排除表 + git2 `is_path_ignored`（复用已有依赖，不新增）。
//!
//! 命令层错误统一 `String`（与 projects.rs 一致），内部用 anyhow。

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;

/// 预览读取上限：超过即拒绝，前端改为提示"用默认程序打开"。
/// 32MB 覆盖绝大多数 PDF / 图片，同时避免把超大文件整个拉进 webview 内存。
const MAX_READ_BYTES: u64 = 32 * 1024 * 1024;

/// 文本判定取样长度（含 NUL 即视为二进制，沿用 git 的启发式）。
const SNIFF_LEN: usize = 8 * 1024;

/// 默认隐藏项：对齐 VS Code `files.exclude` 默认值 + 常见构建产物。
const DEFAULT_EXCLUDES: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "CVS",
    ".DS_Store",
    "Thumbs.db",
    "node_modules",
    "target",
    "dist",
    "dist-ssr",
    ".next",
    ".venv",
    "__pycache__",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    /// 相对根的路径，`/` 分隔（前端用作 key，跨平台统一）。
    pub rel: String,
    /// "file" | "dir" | "symlink"
    pub kind: &'static str,
    pub size: u64,
    pub mtime_ms: i64,
    /// `.gitignore` 命中——前端灰显，不隐藏。
    pub ignored: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub text: String,
    /// 规范化编码名（UTF-8 / GB18030 / BIG5 / UTF-16LE …）。
    pub encoding: String,
    pub bom: bool,
    /// 主要换行风格："\n" | "\r\n"。
    pub eol: &'static str,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub exists: bool,
    pub kind: &'static str,
    pub size: u64,
    pub mtime_ms: i64,
}

// ---- 沙箱 ----

/// 根目录必须存在且是目录；返回 canonicalize 后的路径。
fn root_path(root: &str) -> Result<PathBuf> {
    let p = PathBuf::from(root);
    if !p.is_dir() {
        bail!("知识库根目录不存在或不是目录");
    }
    p.canonicalize().context("无法解析知识库根目录")
}

/// 归一化相对路径：反斜杠转正斜杠、去首尾斜杠、拒绝 `..` 与盘符。
fn normalize_rel(rel: &str) -> Result<String> {
    // 绝对路径显式拒绝，而不是"去掉前导斜杠当相对路径用"。
    // `Path::join` 对绝对路径会**整体替换**基路径；先归一化虽仍落在根内，
    // 但把 `/etc/passwd` 悄悄解释成 `<root>/etc/passwd` 是容易出事的语义
    // （调用方以为在传绝对路径，实际读的是根内同名文件）。文档写"拒绝"，行为就得是拒绝。
    let raw = rel.trim();
    let drive_prefixed = raw.as_bytes().get(1) == Some(&b':')
        && raw.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
    if raw.starts_with('/') || raw.starts_with('\\') || drive_prefixed {
        bail!("路径越界：不允许绝对路径");
    }
    let cleaned = raw.replace('\\', "/");
    let cleaned = cleaned.trim_matches('/');
    if cleaned.split('/').any(|seg| seg == "..") {
        bail!("路径越界：不允许 `..`");
    }
    Ok(cleaned.to_string())
}

/// 把相对路径解析为根内的绝对路径；越界（含符号链接逃逸）一律拒绝。
///
/// 已存在的路径 → canonicalize 后校验（符号链接指向根外会在这里暴露）；
/// 不存在的路径（新建/写入）→ 校验最近的存在祖先，再拼回剩余段。
fn resolve_in_root(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = normalize_rel(rel)?;
    if rel.is_empty() {
        return Ok(root.to_path_buf());
    }
    let joined = root.join(&rel);
    let probe = if joined.exists() {
        joined.canonicalize().context("无法解析路径")?
    } else {
        let mut ancestor = joined.clone();
        let mut suffix: Vec<std::ffi::OsString> = Vec::new();
        while !ancestor.exists() {
            let name = ancestor
                .file_name()
                .map(|n| n.to_os_string())
                .ok_or_else(|| anyhow!("无效路径"))?;
            suffix.push(name);
            ancestor = ancestor
                .parent()
                .ok_or_else(|| anyhow!("无效路径"))?
                .to_path_buf();
        }
        let mut rebuilt = ancestor.canonicalize().context("无法解析路径")?;
        for name in suffix.iter().rev() {
            rebuilt.push(name);
        }
        rebuilt
    };
    if !probe.starts_with(root) {
        bail!("路径越界：不在知识库根内");
    }
    Ok(joined)
}

fn rel_of(rel: &str, name: &str) -> String {
    let rel = rel.trim_matches('/');
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn kind_of(meta: &std::fs::Metadata) -> &'static str {
    if meta.file_type().is_symlink() {
        "symlink"
    } else if meta.is_dir() {
        "dir"
    } else {
        "file"
    }
}

/// `.gitignore` 判定：根（或其祖先）若是 git 仓库，用已有 git2 查忽略规则。
fn is_ignored(repo: Option<&git2::Repository>, abs: &Path) -> bool {
    let Some(repo) = repo else { return false };
    let Some(workdir) = repo.workdir() else {
        return false;
    };
    let Ok(rel) = abs.strip_prefix(workdir) else {
        return false;
    };
    repo.is_path_ignored(rel).unwrap_or(false)
}

// ---- 读 ----

/// 原生文件夹选择：知识库的根。与 `pick_repo` 同构（一次性 channel + 原生对话框），
/// 只是标题不同——知识库不要求是 git 仓库。
#[tauri::command]
pub async fn kb_pick_root(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_dialog::FilePath;

    let (tx, mut rx) = tauri::async_runtime::channel::<Option<String>>(1);
    window
        .dialog()
        .file()
        .set_title("选择知识库文件夹")
        .pick_folder(move |path| {
            let value: Option<String> = path
                .map(|p| match p {
                    FilePath::Path(path_buf) => path_buf.to_string_lossy().to_string(),
                    FilePath::Url(url) => url
                        .to_file_path()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default(),
                })
                .filter(|s| !s.is_empty());
            let _ = tx.blocking_send(value);
        });
    rx.recv().await.ok_or_else(|| "对话框已关闭".to_string())
}

/// 遍历整根，返回**全部文件**的相对路径（⌘P 快速打开要用）。
///
/// 为什么放在 Rust 而不是前端逐层 `kb_list_dir`：一次 IPC 拿全量，几百上千个文件也只有
/// 一次调用；逐层拉会把延迟乘上目录数。忽略规则与树保持同一套（`is_ignored`），
/// 默认跳过 `.git` 与被 gitignore 的项，并设上限避免超大仓库把界面拖死。
#[tauri::command]
pub fn kb_walk(root: String, show_ignored: Option<bool>, limit: Option<usize>) -> Result<Vec<String>, String> {
    let root_abs = root_path(&root).map_err(|e| e.to_string())?;
    let repo = git2::Repository::discover(&root_abs).ok();
    let show_ignored = show_ignored.unwrap_or(false);
    let limit = limit.unwrap_or(20_000);
    let mut out = Vec::new();
    let mut stack = vec![root_abs.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let abs = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            // 与树用**同一套**排除规则：否则树里看不到的 node_modules / target
            // 会在 ⌘P 与搜索结果里冒出来，两边不一致比"少给结果"更让人困惑
            if !show_ignored && DEFAULT_EXCLUDES.contains(&name.as_str()) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(&abs) else { continue };
            if meta.file_type().is_symlink() {
                continue; // 符号链接不跟进：避免环
            }
            if !show_ignored && is_ignored(repo.as_ref(), &abs) {
                continue;
            }
            if meta.is_dir() {
                stack.push(abs);
                continue;
            }
            if let Ok(rel) = abs.strip_prefix(&root_abs) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
                if out.len() >= limit {
                    out.sort();
                    return Ok(out);
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

/// 一条查找命中（全文搜索）。
#[derive(serde::Serialize)]
pub struct SearchHit {
    pub rel: String,
    /// 1 基行号。
    pub line: u32,
    /// 1 基列号（按字符计，前端按它高亮）。
    pub column: u32,
    /// 该行原文（已截断到合理长度）。
    pub text: String,
}

#[derive(serde::Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// 命中文件数（可能 > hits 涉及的文件数，用于提示"还有更多"）。
    pub files: usize,
    /// 是否因为达到上限而截断。
    pub truncated: bool,
}

/// 单个文件大小上限：超过就不搜（二进制/巨型文件只会拖慢，且多半不是要找的东西）。
const SEARCH_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// 单行展示长度上限（列表里放不下更长的）。
const SEARCH_MAX_LINE_CHARS: usize = 400;

/// 全文搜索：遍历整根，按行找子串，返回命中位置。
///
/// 用 Rust 做而不是前端：一是要读上千个文件（IPC 往返不可接受），二是**中文编码**
/// 必须走 `decode_bytes`（GBK/BIG5 等），前端拿到的都是 UTF-8 之后再搜就晚了。
/// 二进制按"含 NUL"跳过；命中数达上限即停并标记 `truncated`。
#[tauri::command]
pub fn kb_search(
    root: String,
    query: String,
    show_ignored: Option<bool>,
    max_hits: Option<usize>,
) -> Result<SearchResult, String> {
    let needle = query.trim().to_string();
    if needle.is_empty() {
        return Ok(SearchResult { hits: Vec::new(), files: 0, truncated: false });
    }
    let root_abs = root_path(&root).map_err(|e| e.to_string())?;
    let repo = git2::Repository::discover(&root_abs).ok();
    let show_ignored = show_ignored.unwrap_or(false);
    let max_hits = max_hits.unwrap_or(500);
    let needle_lower = needle.to_lowercase();

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut files = 0usize;
    let mut truncated = false;
    let mut stack = vec![root_abs.clone()];

    'walk: while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let abs = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            // 与树用**同一套**排除规则：否则树里看不到的 node_modules / target
            // 会在 ⌘P 与搜索结果里冒出来，两边不一致比"少给结果"更让人困惑
            if !show_ignored && DEFAULT_EXCLUDES.contains(&name.as_str()) {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(&abs) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if !show_ignored && is_ignored(repo.as_ref(), &abs) {
                continue;
            }
            if meta.is_dir() {
                stack.push(abs);
                continue;
            }
            if meta.len() > SEARCH_MAX_FILE_BYTES {
                continue;
            }
            let Ok(bytes) = std::fs::read(&abs) else { continue };
            // 二进制（含 NUL）跳过：解码出来也是乱码，还会把内存吃满
            if bytes.iter().take(8192).any(|b| *b == 0) {
                continue;
            }
            let (text, _, _) = decode_bytes(&bytes);
            let Ok(rel) = abs.strip_prefix(&root_abs) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            let mut file_hit = false;
            for (index, raw_line) in text.lines().enumerate() {
                let line = raw_line.trim_end();
                let haystack = line.to_lowercase();
                let Some(column) = haystack.find(&needle_lower) else { continue };
                file_hit = true;
                let start_char = haystack[..column].chars().count() as u32 + 1;
                let display: String = line.chars().take(SEARCH_MAX_LINE_CHARS).collect();
                hits.push(SearchHit { rel: rel.clone(), line: index as u32 + 1, column: start_char, text: display });
                if hits.len() >= max_hits {
                    truncated = true;
                    break 'walk;
                }
            }
            if file_hit {
                files += 1;
            }
        }
    }

    Ok(SearchResult { hits, files, truncated })
}

/// 让**系统**生成一张预览图（Quick Look）——媒体与"没有内置渲染器"的格式靠它兜底。
///
/// 为什么走这条路：WebView 解不了的编码（wmv/mkv/avi/rmvb…）和 macOS 自己的格式
/// （Pages/Numbers/Keynote、sketch 等）我们都没有解码器，但**操作系统有**。
/// `qlmanage -t` 会调用对应的 Quick Look 生成器出 PNG —— 这是桌面应用相对纯 web 的
/// 结构性优势（③适配：能力来自平台）。
///
/// 只在 macOS 上可用；其它平台返回错误，前端退化成"用默认应用打开"。
/// ⚠️ 必须是 **async**：Tauri 的同步命令跑在主线程上，而 qlmanage 对未知二进制
/// 会**永久挂起**（实测：200KB 随机 .bin，20 秒无任何输出）—— 同步等待它 =
/// 整个应用冻结（用户实测"点开 bin 程序直接卡死"）。丢到阻塞线程池 + 带超时击杀。
#[tauri::command]
pub async fn kb_thumbnail(root: String, rel: String, size: Option<u32>) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || thumbnail_bytes(&root, &rel, size.unwrap_or(640)))
        .await
        .map_err(|e| format!("预览任务失败：{e}"))?;
    Ok(tauri::ipc::Response::new(bytes?))
}

/// 命令的实现体（抽出来给单测直接调 —— `Response` 不便在测试里取字节）。
pub fn thumbnail_bytes(root: &str, rel: &str, size: u32) -> Result<Vec<u8>, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (root, rel, size);
        Err("当前平台不支持系统预览图".into())
    }
    #[cfg(target_os = "macos")]
    {
        let root_abs = root_path(root).map_err(|e| e.to_string())?;
        let abs = resolve_in_root(&root_abs, rel).map_err(|e| e.to_string())?;
        if !abs.is_file() {
            return Err("不是文件".into());
        }
        let size = size.clamp(64, 2048);
        // 每次调用用独立临时目录：qlmanage 的输出名带原文件名，共用目录会串
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let out_dir = std::env::temp_dir().join(format!("hivetask-thumb-{}-{}", std::process::id(), stamp));
        std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;

        // ⚠️ 不能用 `.output()`（无限等）：qlmanage 对不认识的文件会挂起不退出。
        // 轮询 try_wait，超时（8s）就杀掉进程——"没有预览图"是可接受的，卡死不可接受。
        const QL_TIMEOUT_MS: u64 = 8_000;
        let child = std::process::Command::new("/usr/bin/qlmanage")
            .arg("-t") // 缩略图模式
            .arg("-s")
            .arg(size.to_string())
            .arg("-o")
            .arg(&out_dir)
            .arg(&abs)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();

        let mut child = match child {
            Ok(child) => child,
            Err(error) => {
                let _ = std::fs::remove_dir_all(&out_dir);
                return Err(format!("调用系统预览失败：{error}"));
            }
        };
        let started = std::time::Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) if started.elapsed().as_millis() as u64 >= QL_TIMEOUT_MS => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err("超时".to_string());
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(error) => break Err(error.to_string()),
            }
        };
        match status {
            Ok(status) if status.success() => {}
            Ok(_) => {
                let _ = std::fs::remove_dir_all(&out_dir);
                return Err("系统未能生成预览图".into());
            }
            Err(reason) => {
                let _ = std::fs::remove_dir_all(&out_dir);
                return Err(format!("系统预览未完成（{reason}）"));
            }
        }
        // 输出文件名 = 原文件名 + ".png"
        let file_name = abs.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let bytes = std::fs::read(out_dir.join(format!("{file_name}.png")));
        let _ = std::fs::remove_dir_all(&out_dir);
        match bytes {
            Ok(bytes) if !bytes.is_empty() => Ok(bytes),
            _ => Err("系统没有为这个文件生成预览图".into()),
        }
    }
}

/// 列出目录一层（懒加载）。
#[tauri::command]
pub fn kb_list_dir(root: String, rel: Option<String>, show_ignored: Option<bool>) -> Result<Vec<Entry>, String> {
    list_dir_in(&root, rel.as_deref().unwrap_or(""), show_ignored.unwrap_or(false)).map_err(|e| e.to_string())
}

pub fn list_dir_in(root: &str, rel: &str, show_ignored: bool) -> Result<Vec<Entry>> {
    let root_abs = root_path(root)?;
    let dir = resolve_in_root(&root_abs, rel)?;
    if !dir.is_dir() {
        bail!("不是目录");
    }
    let repo = git2::Repository::discover(&root_abs).ok();
    let mut out: Vec<Entry> = Vec::new();
    for entry in std::fs::read_dir(&dir).context("读取目录失败")? {
        let entry = entry.context("读取目录项失败")?;
        let name = entry.file_name().to_string_lossy().to_string();
        let abs = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&abs) else {
            continue; // 竞态下消失的条目直接跳过
        };
        if !show_ignored && DEFAULT_EXCLUDES.contains(&name.as_str()) {
            continue;
        }
        let kind = kind_of(&meta);
        out.push(Entry {
            rel: rel_of(rel, &name),
            name,
            kind,
            size: if kind == "file" { meta.len() } else { 0 },
            mtime_ms: mtime_ms(&meta),
            ignored: is_ignored(repo.as_ref(), &abs),
        });
    }
    // 目录在前 + 名称（小写）稳定排序；中文再排序由前端按 localeCompare 处理。
    out.sort_by(|a, b| {
        (a.kind != "dir", a.name.to_lowercase()).cmp(&(b.kind != "dir", b.name.to_lowercase()))
    });
    Ok(out)
}

#[tauri::command]
pub fn kb_stat(root: String, rel: String) -> Result<Stat, String> {
    stat_in(&root, &rel).map_err(|e| e.to_string())
}

pub fn stat_in(root: &str, rel: &str) -> Result<Stat> {
    let root_abs = root_path(root)?;
    let abs = resolve_in_root(&root_abs, rel)?;
    let Ok(meta) = std::fs::symlink_metadata(&abs) else {
        return Ok(Stat {
            exists: false,
            kind: "file",
            size: 0,
            mtime_ms: 0,
        });
    };
    Ok(Stat {
        exists: true,
        kind: kind_of(&meta),
        size: if meta.is_file() { meta.len() } else { 0 },
        mtime_ms: mtime_ms(&meta),
    })
}

/// 读取原始字节（图片 / PDF 等二进制预览用）。
///
/// 走 `ipc::Response` 直接回字节，而不是 `Vec<u8>`（后者会被序列化成 JSON 数组，
/// 大文件下体积与耗时都会放大数倍）。
#[tauri::command]
pub fn kb_read_bytes(root: String, rel: String) -> Result<tauri::ipc::Response, String> {
    let bytes = read_bytes_in(&root, &rel).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

pub fn read_bytes_in(root: &str, rel: &str) -> Result<Vec<u8>> {
    let root_abs = root_path(root)?;
    let abs = resolve_in_root(&root_abs, rel)?;
    let meta = std::fs::metadata(&abs).context("文件不存在")?;
    if !meta.is_file() {
        bail!("不是文件");
    }
    if meta.len() > MAX_READ_BYTES {
        bail!("文件过大（超过 {} MB）", MAX_READ_BYTES / 1024 / 1024);
    }
    std::fs::read(&abs).context("读取文件失败")
}

/// 读取文本：探测编码与 BOM、统一换行风格回传。
#[tauri::command]
pub fn kb_read_text(root: String, rel: String, encoding: Option<String>) -> Result<TextFile, String> {
    read_text_in_forced(&root, &rel, encoding.as_deref()).map_err(|e| e.to_string())
}

/// 自动探测编码的读取（命令走 `read_text_in_forced`，本函数供测试与内部调用）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_text_in(root: &str, rel: &str) -> Result<TextFile> {
    read_text_in_forced(root, rel, None)
}

/// `force_encoding`：用户在状态栏手动指定的编码（覆盖自动探测）。
///
/// 为什么要有：探测是启发式，短文件/混合内容会猜错（比如 GBK 被猜成 BIG5）。
/// 用户眼睛看到乱码时，手动指定是最快的自救；保存链路会用这里返回的编码回写，
/// 所以顺带获得了"转码另存"的能力。
pub fn read_text_in_forced(root: &str, rel: &str, force_encoding: Option<&str>) -> Result<TextFile> {
    let root_abs = root_path(root)?;
    let abs = resolve_in_root(&root_abs, rel)?;
    let meta = std::fs::metadata(&abs).context("文件不存在")?;
    if !meta.is_file() {
        bail!("不是文件");
    }
    if meta.len() > MAX_READ_BYTES {
        bail!("文件过大（超过 {} MB），请用默认程序打开", MAX_READ_BYTES / 1024 / 1024);
    }
    let bytes = std::fs::read(&abs).context("读取文件失败")?;
    if is_binary(&bytes) {
        bail!("二进制文件，无法作为文本打开");
    }
    let (text, encoding, bom) = match force_encoding {
        Some(label) => {
            // 显式指定的编码必须是认识的；BOM 处理保持一致（有 BOM 就剥掉）
            let enc = encoding_rs::Encoding::for_label(label.as_bytes())
                .ok_or_else(|| anyhow!("不认识的编码：{label}"))?;
            let mut offset = 0;
            let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]) && enc == encoding_rs::UTF_8;
            if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
                offset = 3;
            } else if bytes.starts_with(&[0xFF, 0xFE]) && enc == encoding_rs::UTF_16LE {
                offset = 2;
            } else if bytes.starts_with(&[0xFE, 0xFF]) && enc == encoding_rs::UTF_16BE {
                offset = 2;
            }
            // fatal=false：错误字节替换成 U+FFFD 并如实上报，让用户知道"这个编码对不上"
            let (text, _, had_errors) = enc.decode(&bytes[offset..]);
            let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
            let mut result = TextFile {
                text: text.into_owned(),
                encoding: enc.name().to_string(),
                bom,
                eol: eol.into(),
                size: bytes.len() as u64,
                mtime_ms: 0,
            };
            let meta = std::fs::metadata(&abs).context("读取文件信息失败")?;
            result.mtime_ms = mtime_ms(&meta);
            if had_errors {
                result.text = format!("⚠️ 按 {label} 解码时存在无法映射的字节（显示为 \u{FFFD}）——这个编码可能不对。\n\n{}", result.text);
            }
            return Ok(result);
        }
        None => decode_bytes(&bytes),
    };
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    Ok(TextFile {
        text,
        encoding: encoding.name().to_string(),
        bom,
        eol,
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
    })
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(SNIFF_LEN).any(|b| *b == 0)
}

/// 解码：BOM 优先 → 严格 UTF-8 → chardetng 探测（覆盖 GBK/GB18030/BIG5/日韩）。
fn decode_bytes(bytes: &[u8]) -> (String, &'static encoding_rs::Encoding, bool) {
    use encoding_rs::{UTF_16BE, UTF_16LE, UTF_8};
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        let (text, _, _) = UTF_8.decode(rest);
        return (text.into_owned(), UTF_8, true);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let (text, _, _) = UTF_16LE.decode(rest);
        return (text.into_owned(), UTF_16LE, true);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let (text, _, _) = UTF_16BE.decode(rest);
        return (text.into_owned(), UTF_16BE, true);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_string(), UTF_8, false);
    }
    // chardetng 1.0 的两个开关都是枚举：本地知识库非脚本执行环境，
    // 允许 UTF-8 与 ISO-2022-JP（日文邮件/文档常见）。
    let mut detector =
        chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    let encoding = detector.guess(None, chardetng::Utf8Detection::Allow);
    let (text, _, _) = encoding.decode(bytes);
    (text.into_owned(), encoding, false)
}

// ---- 写 ----

/// 新建空文件或目录（VS Code 侧栏的「新建文件 / 新建文件夹」）。
/// 目标已存在 → 报错，不静默覆盖。
#[tauri::command]
pub fn kb_create(root: String, rel: String, kind: String) -> Result<Entry, String> {
    create_in(&root, &rel, &kind).map_err(|e| e.to_string())
}

pub fn create_in(root: &str, rel: &str, kind: &str) -> Result<Entry> {
    let root_abs = root_path(root)?;
    let normalized = normalize_rel(rel)?;
    if normalized.is_empty() {
        bail!("名称不能为空");
    }
    let name = normalized
        .rsplit('/')
        .next()
        .ok_or_else(|| anyhow!("名称不能为空"))?
        .to_string();
    if name == "." || name == ".." || name.contains('\\') {
        bail!("名称不合法");
    }
    let abs = resolve_in_root(&root_abs, &normalized)?;
    if abs.exists() {
        bail!("同名文件或文件夹已存在");
    }
    let parent = abs.parent().ok_or_else(|| anyhow!("无效路径"))?;
    if !parent.is_dir() {
        bail!("上级目录不存在");
    }
    match kind {
        "dir" => std::fs::create_dir(&abs).context("新建文件夹失败")?,
        "file" => {
            // create_new：并发下不会覆盖别人刚建的文件
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&abs)
                .context("新建文件失败")?;
        }
        other => bail!("不支持的类型：{other}"),
    }
    let meta = std::fs::symlink_metadata(&abs).context("读取新条目失败")?;
    let repo = git2::Repository::discover(&root_abs).ok();
    Ok(Entry {
        rel: normalized,
        name,
        kind: kind_of(&meta),
        size: if meta.is_file() { meta.len() } else { 0 },
        mtime_ms: mtime_ms(&meta),
        ignored: is_ignored(repo.as_ref(), &abs),
    })
}

/// 写入文本：**按原编码回写**（否则"打开 GBK、存成 UTF-8"在别人机器上必乱码），
/// 并在外部改动时拒绝覆盖（`expected_mtime_ms` 不符 → 冲突错）。
///
/// 返回写入后的 mtime，前端据此更新基线。
#[tauri::command]
pub fn kb_write_text(
    root: String,
    rel: String,
    text: String,
    encoding: String,
    bom: bool,
    eol: String,
    expected_mtime_ms: Option<i64>,
) -> Result<i64, String> {
    write_text_in(&root, &rel, &text, &encoding, bom, &eol, expected_mtime_ms).map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
pub fn write_text_in(
    root: &str,
    rel: &str,
    text: &str,
    encoding: &str,
    bom: bool,
    eol: &str,
    expected_mtime_ms: Option<i64>,
) -> Result<i64> {
    let root_abs = root_path(root)?;
    let abs = resolve_in_root(&root_abs, rel)?;
    if let Ok(meta) = std::fs::metadata(&abs) {
        if let Some(expected) = expected_mtime_ms {
            let current = mtime_ms(&meta);
            if current != expected {
                bail!("文件已被外部修改，请重新打开后再编辑");
            }
        }
    }
    let normalized = if eol == "\r\n" {
        text.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        text.replace("\r\n", "\n")
    };
    let enc = encoding_rs::Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| anyhow!("不支持的编码：{encoding}"))?;
    let mut bytes: Vec<u8> = Vec::new();
    if bom {
        if enc == encoding_rs::UTF_8 {
            bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        } else if enc == encoding_rs::UTF_16LE {
            bytes.extend_from_slice(&[0xFF, 0xFE]);
        } else if enc == encoding_rs::UTF_16BE {
            bytes.extend_from_slice(&[0xFE, 0xFF]);
        }
    }
    let (encoded, _, had_errors) = enc.encode(&normalized);
    if had_errors {
        bail!("当前编码（{}）无法表示部分字符，请改存 UTF-8", enc.name());
    }
    bytes.extend_from_slice(&encoded);

    // 同目录临时文件 + rename：避免写到一半崩溃留下半截文件。
    let dir = abs.parent().ok_or_else(|| anyhow!("无效路径"))?;
    let tmp = dir.join(format!(".hivetask-tmp-{}", std::process::id()));
    std::fs::write(&tmp, &bytes).context("写入临时文件失败")?;
    std::fs::rename(&tmp, &abs).context("替换目标文件失败")?;
    let meta = std::fs::metadata(&abs).context("写入后读取文件状态失败")?;
    Ok(mtime_ms(&meta))
}

#[cfg(test)]
mod kb_tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hivetask-kb-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }


    // ---- ⌘P 快速打开与全文搜索（T10 的两块地基）----

    #[test]
    fn walk_lists_all_files_sorted_and_skips_git_and_ignored() {
        let root = temp_root("walk");
        // 与 list_dir 的忽略测试同一前提：**必须是 git 仓库**，否则 .gitignore 不生效
        git2::Repository::init(&root).unwrap();
        std::fs::create_dir_all(root.join("sub/deep")).unwrap();
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        std::fs::write(root.join("b.md"), "b").unwrap();
        std::fs::write(root.join("sub/a.md"), "a").unwrap();
        std::fs::write(root.join("sub/deep/c.md"), "c").unwrap();
        std::fs::write(root.join(".git/objects/secret"), "x").unwrap();
        std::fs::write(root.join(".gitignore"), "ignored.md\n").unwrap();
        std::fs::write(root.join("ignored.md"), "nope").unwrap();

        let root_str = root.to_string_lossy().to_string();
        let walked = kb_walk(root_str.clone(), None, None).unwrap();
        // `.gitignore` 自己是个普通文件（树里也显示），所以**应当**在结果里；
        // 被 ignore 的 ignored.md、以及 .git/ 里的东西不该出现
        assert_eq!(
            walked,
            vec![".gitignore", "b.md", "sub/a.md", "sub/deep/c.md"],
            "应递归、排序、跳过 .git 与忽略项"
        );

        let with_ignored = kb_walk(root_str, Some(true), None).unwrap();
        assert!(with_ignored.iter().any(|p| p == "ignored.md"), "show_ignored=1 时应包含被忽略文件");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_respects_limit() {
        let root = temp_root("walk-limit");
        for i in 0..10 {
            std::fs::write(root.join(format!("f{i}.md")), "x").unwrap();
        }
        let walked = kb_walk(root.to_string_lossy().to_string(), None, Some(3)).unwrap();
        assert_eq!(walked.len(), 3, "上限应生效（超大仓库不能把界面拖死）");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_finds_hits_with_line_and_column() {
        let root = temp_root("search");
        std::fs::write(root.join("doc.md"), "第一行\nabc 目标 def\n再一行目标\n").unwrap();
        let result = kb_search(root.to_string_lossy().to_string(), "目标".into(), None, None).unwrap();
        assert_eq!(result.hits.len(), 2);
        assert_eq!(result.hits[0].rel, "doc.md");
        assert_eq!(result.hits[0].line, 2);
        assert_eq!(result.hits[0].column, 5, "列号按**字符**算（中文场景不能用字节偏移）");
        assert_eq!(result.hits[1].line, 3);
        assert_eq!(result.files, 1);
        assert!(!result.truncated);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_decodes_legacy_chinese_encodings() {
        // 这条是"搜索为什么必须放 Rust"的原因：GBK 文件在前端已是乱码，搜不到
        let root = temp_root("search-gbk");
        let root_str = root.to_string_lossy().to_string();
        let (bytes, _, _) = encoding_rs::GBK.encode("河南神马氯碱");
        std::fs::write(root.join("gbk.txt"), &bytes[..]).unwrap();

        let result = kb_search(root_str.clone(), "神马".into(), None, None).unwrap();
        assert_eq!(result.hits.len(), 1, "GBK 文件也要能搜到");
        assert_eq!(result.hits[0].line, 1);
        // 列号按解码后的字符算：河南=2 字符 → 命中从第 3 列开始
        assert_eq!(result.hits[0].column, 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_skips_binary_and_truncates_at_limit() {
        let root = temp_root("search-binary");
        let root_str = root.to_string_lossy().to_string();
        std::fs::write(root.join("bin.dat"), [0x00, 0x01, 0x02, 0x6f, 0x00]).unwrap();
        // 命中**每行一条**（结果列表一行一条，同行多处只出一条）
        std::fs::write(root.join("text.md"), "命中一\n命中二\n命中三\n命中四\n命中五\n").unwrap();

        let result = kb_search(root_str.clone(), "命中".into(), None, None).unwrap();
        assert_eq!(result.hits.len(), 5, "二进制应被跳过（含 NUL 即视为二进制）");
        assert_eq!(result.files, 1);

        let limited = kb_search(root_str, "命中".into(), None, Some(2)).unwrap();
        assert_eq!(limited.hits.len(), 2);
        assert!(limited.truncated, "达到上限要标记截断，界面才好提示还有更多");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn search_empty_query_returns_nothing() {
        let root = temp_root("search-empty");
        let result = kb_search(root.to_string_lossy().to_string(), "   ".into(), None, None).unwrap();
        assert!(result.hits.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn forced_encoding_overrides_detection_and_reports_errors() {
        let root = temp_root("forced-enc");
        let root_str = root.to_string_lossy().to_string();
        // "中文测试" 的 GBK 字节
        let gbk_bytes: Vec<u8> = vec![0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4];
        std::fs::write(root.join("a.txt"), &gbk_bytes).unwrap();

        // 强制按 GBK：与探测结果一致，正常解码
        let as_gbk = read_text_in_forced(&root_str, "a.txt", Some("gbk")).unwrap();
        assert_eq!(as_gbk.text, "中文测试");
        assert_eq!(as_gbk.encoding, "GBK");

        // 强制按错误编码（Latin-1）：不报错但产出乱码字节映射（用户自己会看出来并换）
        let as_latin = read_text_in_forced(&root_str, "a.txt", Some("windows-1252")).unwrap();
        assert_eq!(as_latin.encoding, "windows-1252");
        assert_ne!(as_latin.text, "中文测试");

        // 不认识的编码名 → 明确报错
        assert!(read_text_in_forced(&root_str, "a.txt", Some("not-a-codepage")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn thumbnail_uses_system_quick_look_and_respects_sandbox() {
        let root = temp_root("thumb");
        let root_str = root.to_string_lossy().to_string();
        // 1×1 的 PNG（Quick Look 能直接为图片出图）
        let png: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
            0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
            0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
            0x42, 0x60, 0x82,
        ];
        std::fs::write(root.join("pic.png"), &png).unwrap();

        // 沙箱：根外的路径必须被拒（不能靠它去读整块磁盘）。
        // 走实现体（thumbnail_bytes）而不是命令包装 —— 后者现在是 async。
        assert!(thumbnail_bytes(&root_str, "../outside.png", 128).is_err());

        // 正常路径：拿到的是 PNG 字节（Quick Look 的产物）
        match thumbnail_bytes(&root_str, "pic.png", 128) {
            Ok(bytes) => {
                assert!(bytes.len() > 8, "应拿到非空的预览图");
                assert_eq!(&bytes[..4], &[0x89, 0x50, 0x4E, 0x47], "应是 PNG 头");
            }
            // 无头 CI / 未登录图形会话下 qlmanage 可能不可用：允许失败，但必须是"清晰错误"
            Err(message) => assert!(message.contains("预览") || message.contains("系统"), "{message}"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sandbox_rejects_escape_attempts() {
        let root = temp_root("sandbox");
        let root_str = root.to_string_lossy().to_string();
        let outside = std::env::temp_dir().join("hivetask-kb-outside.txt");
        std::fs::write(&outside, "secret").unwrap();

        assert!(resolve_in_root(&root, "../secret.txt").is_err(), "`..` 必须被拒");
        assert!(resolve_in_root(&root, "/etc/passwd").is_err(), "绝对路径必须被拒");
        assert!(read_text_in(&root_str, "../outside.txt").is_err());

        // 符号链接指向根外 → 同样拒绝
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("link.txt")).unwrap();
            assert!(read_text_in(&root_str, "link.txt").is_err(), "符号链接逃逸必须被拒");
        }

        // 正常路径可用
        std::fs::write(root.join("ok.md"), "hello").unwrap();
        assert_eq!(read_text_in(&root_str, "ok.md").unwrap().text, "hello");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn decodes_gbk_and_round_trips_it() {
        let root = temp_root("gbk");
        let root_str = root.to_string_lossy().to_string();
        // "中文测试" 的 GBK 字节
        let gbk_bytes: Vec<u8> = vec![0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4];
        std::fs::write(root.join("gbk.txt"), &gbk_bytes).unwrap();

        let read = read_text_in(&root_str, "gbk.txt").unwrap();
        assert_eq!(read.text, "中文测试");
        assert!(read.encoding.starts_with("GB"), "探测到的编码应为 GB 系，实际 {}", read.encoding);
        assert!(!read.bom);

        // 按原编码回写 → 字节必须与原文一致（这正是"打开没改也别改文件"的底线）
        write_text_in(
            &root_str,
            "gbk.txt",
            &read.text,
            &read.encoding,
            read.bom,
            read.eol,
            Some(read.mtime_ms),
        )
        .unwrap();
        let after = std::fs::read(root.join("gbk.txt")).unwrap();
        assert_eq!(after, gbk_bytes, "GBK 文件回写后字节应与原文件一致");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn keeps_utf8_bom_and_crlf() {
        let root = temp_root("bom");
        let root_str = root.to_string_lossy().to_string();
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("第一行\r\n第二行\r\n".as_bytes());
        std::fs::write(root.join("bom.md"), &bytes).unwrap();

        let read = read_text_in(&root_str, "bom.md").unwrap();
        assert!(read.bom);
        assert_eq!(read.encoding, "UTF-8");
        assert_eq!(read.eol, "\r\n");
        assert_eq!(read.text, "第一行\r\n第二行\r\n");

        write_text_in(&root_str, "bom.md", &read.text, &read.encoding, read.bom, read.eol, None).unwrap();
        assert_eq!(std::fs::read(root.join("bom.md")).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_rejects_stale_mtime_and_supports_new_file() {
        let root = temp_root("conflict");
        let root_str = root.to_string_lossy().to_string();
        std::fs::write(root.join("note.md"), "v1").unwrap();
        let read = read_text_in(&root_str, "note.md").unwrap();

        let stale = write_text_in(&root_str, "note.md", "v2", "UTF-8", false, "\n", Some(read.mtime_ms - 1_000));
        assert!(stale.is_err(), "mtime 不符必须拒绝覆盖");

        write_text_in(&root_str, "new/child.md", "created", "UTF-8", false, "\n", None)
            .expect_err("父目录不存在时应报错而不是静默失败");

        std::fs::create_dir_all(root.join("new")).unwrap();
        write_text_in(&root_str, "new/child.md", "created", "UTF-8", false, "\n", None).unwrap();
        assert_eq!(read_text_in(&root_str, "new/child.md").unwrap().text, "created");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_dir_hides_excludes_and_flags_gitignored() {
        let root = temp_root("list");
        let root_str = root.to_string_lossy().to_string();
        git2::Repository::init(&root).unwrap();
        std::fs::write(root.join(".gitignore"), "secret.txt\n").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("secret.txt"), "s").unwrap();
        std::fs::write(root.join("readme.md"), "r").unwrap();
        std::fs::create_dir_all(root.join("docs")).unwrap();

        let listed = list_dir_in(&root_str, "", false).unwrap();
        let names: Vec<&str> = listed.iter().map(|e| e.name.as_str()).collect();
        assert!(!names.contains(&"node_modules"), "默认排除项应被隐藏：{names:?}");
        assert!(names.contains(&"docs") && names.contains(&"readme.md"));
        assert_eq!(names[0], "docs", "目录应排在文件前");

        let secret = listed.iter().find(|e| e.name == "secret.txt").unwrap();
        assert!(secret.ignored, "gitignore 命中项应带 ignored 标记");

        let all = list_dir_in(&root_str, "docs", false).unwrap();
        assert!(all.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn app_for_uses_extension_override_else_system_default() {
        let prefs = OpenWithPrefs {
            by_ext: std::collections::BTreeMap::from([(
                "pdf".to_string(),
                "/Applications/Preview.app".to_string(),
            )]),
        };
        assert_eq!(app_for(&prefs, "docs/a.pdf"), "/Applications/Preview.app", "按扩展名命中");
        assert_eq!(app_for(&prefs, "docs/A.PDF"), "/Applications/Preview.app", "大小写不敏感");
        assert_eq!(app_for(&prefs, "docs/a.md"), "", "没配的扩展名 → 空 = 系统默认程序");
        assert_eq!(app_for(&prefs, "LICENSE"), "", "无扩展名 → 空 = 系统默认程序");

        let blank = OpenWithPrefs {
            by_ext: std::collections::BTreeMap::from([("pdf".to_string(), "   ".to_string())]),
        };
        assert_eq!(app_for(&blank, "a.pdf"), "", "空白值视为未配置");
    }

    #[test]
    fn prefs_round_trip_through_app_db() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::appdb::app_migrate(&conn).unwrap();
        assert!(open_with_get(&conn).unwrap().by_ext.is_empty(), "未写入时为空配置");

        let prefs = OpenWithPrefs {
            by_ext: std::collections::BTreeMap::from([(
                "pdf".to_string(),
                "/Applications/Preview.app".to_string(),
            )]),
        };
        let json = serde_json::to_string(&prefs).unwrap();
        conn.execute(
            "INSERT INTO prefs (key, value, updated_at) VALUES (?1, ?2, ?3)",
            rusqlite::params![OPEN_WITH_KEY, json, crate::appdb::chrono_like_now()],
        )
        .unwrap();

        let back = open_with_get(&conn).unwrap();
        assert_eq!(
            back.by_ext.get("pdf").map(String::as_str),
            Some("/Applications/Preview.app")
        );

        // 旧版写过的 `defaultApp` 字段：反序列化必须照旧通过（不报错），只是不再有语义
        let legacy = r#"{"defaultApp":"Typora","byExt":{"md":"Typora"}}"#;
        let parsed: OpenWithPrefs = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.by_ext.get("md").map(String::as_str), Some("Typora"));
    }

    #[test]
    fn open_external_rejects_paths_outside_root() {
        // 沙箱与 kb_read_text 同一套逻辑：越界在解析阶段就被拒（不需要 AppHandle）
        let root = temp_root("openext");
        let root_abs = root_path(&root.to_string_lossy()).unwrap();
        assert!(resolve_in_root(&root_abs, "../escape.txt").is_err());
        assert!(resolve_in_root(&root_abs, "/etc/passwd").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_supports_files_and_directories_without_overwrite() {
        let root = temp_root("copy");
        let root_str = root.to_string_lossy().to_string();
        std::fs::create_dir_all(root.join("docs/sub")).unwrap();
        std::fs::write(root.join("docs/a.md"), "hello").unwrap();
        std::fs::write(root.join("docs/sub/b.md"), "b").unwrap();

        // 文件复制（源保留）
        let entry = copy_in(&root_str, "docs/a.md", "docs/copy.md").unwrap();
        assert_eq!(entry.rel, "docs/copy.md");
        assert!(root.join("docs/a.md").exists(), "复制不删源");
        assert_eq!(std::fs::read_to_string(root.join("docs/copy.md")).unwrap(), "hello");

        // 目录递归复制
        copy_in(&root_str, "docs/sub", "docs/sub2").unwrap();
        assert!(root.join("docs/sub2/b.md").exists());
        assert!(root.join("docs/sub/b.md").exists(), "源目录保留");

        // 不覆盖 / 不进自身子树 / 越界
        assert!(copy_in(&root_str, "docs/a.md", "docs/copy.md").is_err());
        assert!(copy_in(&root_str, "docs", "docs/sub/inside").is_err(), "目录不能复制进自身");
        assert!(copy_in(&root_str, "docs/a.md", "../out.md").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn move_relocates_and_cleans_up_source() {
        let root = temp_root("move");
        let root_str = root.to_string_lossy().to_string();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/b/f.md"), "x").unwrap();

        // 改名式移动
        let entry = move_in(&root_str, "a/b/f.md", "a/b/g.md").unwrap();
        assert_eq!(entry.rel, "a/b/g.md");
        assert!(!root.join("a/b/f.md").exists());

        // 跨目录移动（目录也能搬）
        move_in(&root_str, "a/b", "target").unwrap();
        assert!(root.join("target/g.md").exists());
        assert!(!root.join("a/b").exists());

        // 目标已存在 / 越界
        std::fs::write(root.join("x.md"), "1").unwrap();
        assert!(move_in(&root_str, "x.md", "target/g.md").is_err());
        assert!(move_in(&root_str, "x.md", "../escape.md").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rename_moves_within_root_and_rejects_conflicts() {
        let root = temp_root("rename");
        let root_str = root.to_string_lossy().to_string();
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/a.md"), "x").unwrap();

        let entry = rename_in(&root_str, "docs/a.md", "docs/b.md").unwrap();
        assert_eq!(entry.rel, "docs/b.md");
        assert!(!root.join("docs/a.md").exists());
        assert!(root.join("docs/b.md").exists());

        // 同名目标已存在 → 拒绝（不覆盖）
        std::fs::write(root.join("docs/c.md"), "y").unwrap();
        assert!(rename_in(&root_str, "docs/b.md", "docs/c.md").is_err());

        // 新旧同名 / 源不存在 / 目标父目录不存在 / 越界
        assert!(rename_in(&root_str, "docs/c.md", "docs/c.md").is_err());
        assert!(rename_in(&root_str, "docs/missing.md", "docs/d.md").is_err());
        assert!(rename_in(&root_str, "docs/c.md", "nope/d.md").is_err());
        assert!(rename_in(&root_str, "docs/c.md", "../escape.md").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_removes_file_and_rejects_root() {
        let root = temp_root("delete");
        let root_str = root.to_string_lossy().to_string();
        std::fs::write(root.join("gone.md"), "x").unwrap();

        delete_in(&root_str, "gone.md").unwrap();
        assert!(!root.join("gone.md").exists());
        // 幂等：已经不在了也算达成
        delete_in(&root_str, "gone.md").unwrap();

        // 根目录不可删、越界拒绝
        assert!(delete_in(&root_str, "").is_err());
        assert!(delete_in(&root_str, "../outside.md").is_err());

        std::fs::create_dir_all(root.join("dir/inner")).unwrap();
        std::fs::write(root.join("dir/inner/f.md"), "x").unwrap();
        delete_in(&root_str, "dir").unwrap();
        assert!(!root.join("dir").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn base64_decodes_standard_alphabet_and_padding() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("aGVsbG8h").unwrap(), b"hello!");
        assert_eq!(decode_base64("YQ==").unwrap(), b"a");
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
        // 换行/空格按标准允许忽略（macOS 的 base64 会折行）
        assert_eq!(decode_base64("aGVs\nbG8=").unwrap(), b"hello");
        assert!(decode_base64("!!!!").is_err(), "非法字符应报错");
        assert!(decode_base64("a").is_err(), "长度为 1 的分片非法");
    }

    #[test]
    fn write_bytes_creates_parent_dirs_and_stays_in_root() {
        use base64_support::encode;
        let root = temp_root("bytes");
        let root_str = root.to_string_lossy().to_string();

        // 父目录不存在 → 自动创建（粘贴插图写 assets/ 的情形）
        let entry = write_bytes_in(&root_str, "assets/img/a.bin", &encode(&[1u8, 2, 3, 254])).unwrap();
        assert_eq!(entry.rel, "assets/img/a.bin");
        assert_eq!(entry.size, 4);
        assert_eq!(std::fs::read(root.join("assets/img/a.bin")).unwrap(), vec![1u8, 2, 3, 254]);

        // 覆盖写：内容替换
        write_bytes_in(&root_str, "assets/img/a.bin", &encode(&[9u8])).unwrap();
        assert_eq!(std::fs::read(root.join("assets/img/a.bin")).unwrap(), vec![9u8]);

        // 越界仍被拒
        assert!(write_bytes_in(&root_str, "../escape.bin", &encode(&[1u8])).is_err());
        assert!(write_bytes_in(&root_str, "/tmp/escape.bin", &encode(&[1u8])).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 测试用：把字节编成 base64（只在这组用例里用，不进产品代码）。
    mod base64_support {
        const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        pub fn encode(data: &[u8]) -> String {
            let mut out = String::new();
            for chunk in data.chunks(3) {
                let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
                let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
                out.push(TABLE[(n >> 18) as usize & 63] as char);
                out.push(TABLE[(n >> 12) as usize & 63] as char);
                out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
                out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
            }
            out
        }
    }

    #[test]
    fn create_makes_file_and_dir_without_overwriting() {
        let root = temp_root("create");
        let root_str = root.to_string_lossy().to_string();

        let file = create_in(&root_str, "notes.md", "file").unwrap();
        assert_eq!(file.name, "notes.md");
        assert_eq!(file.kind, "file");
        assert!(root.join("notes.md").is_file());

        let dir = create_in(&root_str, "子目录", "dir").unwrap();
        assert_eq!(dir.kind, "dir");
        assert!(root.join("子目录").is_dir(), "中文名目录应创建成功");

        assert!(create_in(&root_str, "notes.md", "file").is_err(), "同名不得覆盖");
        assert!(create_in(&root_str, "../escape.md", "file").is_err(), "越界必须被拒");
        assert!(create_in(&root_str, "missing/inner.md", "file").is_err(), "上级不存在应报错");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_text_rejects_binary_and_dirs() {
        let root = temp_root("binary");
        let root_str = root.to_string_lossy().to_string();
        std::fs::write(root.join("bin.dat"), [0x00, 0x01, 0x02, 0x03]).unwrap();
        assert!(read_text_in(&root_str, "bin.dat").is_err(), "含 NUL 的文件应判为二进制");
        assert!(read_text_in(&root_str, "bin.dat").is_err());
        assert!(read_text_in(&root_str, "").is_err(), "目录不能当文本读");
        assert!(!stat_in(&root_str, "missing.md").unwrap().exists);
        let _ = std::fs::remove_dir_all(&root);
    }
}

// ---- 复制 / 移动（树右键菜单的剪切-粘贴、复制-粘贴、移动到…）----

/// 目标路径校验（复制/移动共用）：目标父目录必须存在、目标不得已存在、不得移进自身子树。
fn check_destination(root_abs: &Path, source: &Path, dest_rel: &str) -> Result<PathBuf> {
    let normalized = normalize_rel(dest_rel)?;
    if normalized.is_empty() {
        bail!("目标路径不能为空");
    }
    let target = resolve_in_root(root_abs, &normalized)?;
    if target == source {
        bail!("源与目标相同");
    }
    if target.exists() {
        bail!("同名文件或文件夹已存在");
    }
    // 目录不能被移进自己的子树（否则会自我吞掉）
    if source.is_dir() && target.starts_with(source) {
        bail!("不能把目录移动到它自己的子目录里");
    }
    let parent = target.parent().ok_or_else(|| anyhow!("无效路径"))?;
    if !parent.is_dir() {
        bail!("目标目录不存在");
    }
    Ok(target)
}

fn entry_for(root_abs: &Path, rel: &str, abs: &Path) -> Result<Entry> {
    let meta = std::fs::symlink_metadata(abs).context("读取条目失败")?;
    let name = rel
        .rsplit('/')
        .next()
        .ok_or_else(|| anyhow!("无效路径"))?
        .to_string();
    let repo = git2::Repository::discover(root_abs).ok();
    Ok(Entry {
        rel: rel.to_string(),
        name,
        kind: kind_of(&meta),
        size: if meta.is_file() { meta.len() } else { 0 },
        mtime_ms: mtime_ms(&meta),
        ignored: is_ignored(repo.as_ref(), abs),
    })
}

/// 递归复制（文件或整棵目录）。
fn copy_recursive(source: &Path, target: &Path) -> Result<()> {
    if source.is_dir() {
        std::fs::create_dir_all(target).context("创建目录失败")?;
        for child in std::fs::read_dir(source).context("读取目录失败")? {
            let child = child.context("读取目录项失败")?;
            let name = child.file_name();
            copy_recursive(&child.path(), &target.join(name))?;
        }
        Ok(())
    } else {
        std::fs::copy(source, target).context("复制文件失败")?;
        Ok(())
    }
}

/// 复制（保留源；目录递归）。
#[tauri::command]
pub fn kb_copy(root: String, from: String, to: String) -> Result<Entry, String> {
    copy_in(&root, &from, &to).map_err(|e| e.to_string())
}

pub fn copy_in(root: &str, from: &str, to: &str) -> Result<Entry> {
    let root_abs = root_path(root)?;
    let source = resolve_in_root(&root_abs, from)?;
    if !source.exists() {
        bail!("源文件不存在");
    }
    let target = check_destination(&root_abs, &source, to)?;
    copy_recursive(&source, &target)?;
    entry_for(&root_abs, &normalize_rel(to)?, &target)
}

/// 移动（重命名到别处；目录可跨目录搬）。
#[tauri::command]
pub fn kb_move(root: String, from: String, to: String) -> Result<Entry, String> {
    move_in(&root, &from, &to).map_err(|e| e.to_string())
}

pub fn move_in(root: &str, from: &str, to: &str) -> Result<Entry> {
    let root_abs = root_path(root)?;
    let source = resolve_in_root(&root_abs, from)?;
    if !source.exists() {
        bail!("源文件不存在");
    }
    let target = check_destination(&root_abs, &source, to)?;
    std::fs::rename(&source, &target).or_else(|_| {
        // 跨文件系统 rename 会失败 → 退回复制 + 删除
        copy_recursive(&source, &target)?;
        if source.is_dir() {
            std::fs::remove_dir_all(&source).context("清理源目录失败")?;
        } else {
            std::fs::remove_file(&source).context("清理源文件失败")?;
        }
        Ok::<(), anyhow::Error>(())
    })?;
    entry_for(&root_abs, &normalize_rel(to)?, &target)
}

// ---- 重命名 / 删除（树右键菜单）----

/// 重命名（同目录内改名；也支持改到子路径，但**必须仍在根内**）。
///
/// 目标已存在 → 报错（不覆盖）；`to` 的父目录必须已存在（重命名不负责造目录）。
#[tauri::command]
pub fn kb_rename(root: String, from: String, to: String) -> Result<Entry, String> {
    rename_in(&root, &from, &to).map_err(|e| e.to_string())
}

pub fn rename_in(root: &str, from: &str, to: &str) -> Result<Entry> {
    let root_abs = root_path(root)?;
    let source = resolve_in_root(&root_abs, from)?;
    if !source.exists() {
        bail!("源文件不存在");
    }
    let normalized_to = normalize_rel(to)?;
    if normalized_to.is_empty() {
        bail!("目标名称不能为空");
    }
    let target = resolve_in_root(&root_abs, &normalized_to)?;
    if target == source {
        bail!("新旧名称相同");
    }
    if target.exists() {
        bail!("同名文件或文件夹已存在");
    }
    let parent = target.parent().ok_or_else(|| anyhow!("无效路径"))?;
    if !parent.is_dir() {
        bail!("目标目录不存在");
    }
    std::fs::rename(&source, &target).context("重命名失败")?;
    let meta = std::fs::symlink_metadata(&target).context("读取新条目失败")?;
    let name = normalized_to
        .rsplit('/')
        .next()
        .ok_or_else(|| anyhow!("无效路径"))?
        .to_string();
    let repo = git2::Repository::discover(&root_abs).ok();
    Ok(Entry {
        rel: normalized_to,
        name,
        kind: kind_of(&meta),
        size: if meta.is_file() { meta.len() } else { 0 },
        mtime_ms: mtime_ms(&meta),
        ignored: is_ignored(repo.as_ref(), &target),
    })
}

/// 删除（**进系统回收站**，失败才退永久删除）。
///
/// 直接 `remove_file` 会让人一次误点就永久丢文件；回收站让误操作可恢复。
#[tauri::command]
pub fn kb_delete(root: String, rel: String) -> Result<(), String> {
    delete_in(&root, &rel).map_err(|e| e.to_string())
}

pub fn delete_in(root: &str, rel: &str) -> Result<()> {
    let root_abs = root_path(root)?;
    let abs = resolve_in_root(&root_abs, rel)?;
    if !abs.exists() {
        return Ok(()); // 已经不在了 = 目标达成
    }
    if abs == root_abs {
        bail!("不能删除知识库根目录");
    }
    if trash::delete(&abs).is_ok() {
        return Ok(());
    }
    // 回收站不可用（某些文件系统/权限）→ 退回真删，行为与"删除"语义一致
    if abs.is_dir() {
        std::fs::remove_dir_all(&abs).context("删除目录失败")
    } else {
        std::fs::remove_file(&abs).context("删除文件失败")
    }
}

// ---- 写二进制（粘贴/拖放插图）----

/// Base64 解码（标准字母表 + `=` 填充）。
///
/// 自己实现而不引 crate：只为这一处用途，30 行、有单测；
/// 也避免为了传图片再动依赖表。
fn decode_base64(input: &str) -> Result<Vec<u8>> {
    fn sextet(byte: u8) -> Option<u8> {
        match byte {
            b'A'..=b'Z' => Some(byte - b'A'),
            b'a'..=b'z' => Some(byte - b'a' + 26),
            b'0'..=b'9' => Some(byte - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let cleaned: Vec<u8> = input
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    let mut out = Vec::with_capacity(cleaned.len() / 4 * 3);
    for chunk in cleaned.chunks(4) {
        if chunk.len() == 1 {
            bail!("Base64 长度非法");
        }
        let mut buffer = 0u32;
        let mut sextets = 0;
        for &byte in chunk {
            if byte == b'=' {
                break;
            }
            let value = sextet(byte).ok_or_else(|| anyhow!("Base64 含非法字符"))?;
            buffer = (buffer << 6) | u32::from(value);
            sextets += 1;
        }
        if sextets == 0 {
            continue;
        }
        buffer <<= 6 * (4 - sextets);
        let bytes = buffer.to_be_bytes();
        out.push(bytes[1]);
        if sextets >= 3 {
            out.push(bytes[2]);
        }
        if sextets == 4 {
            out.push(bytes[3]);
        }
    }
    Ok(out)
}

/// 写入二进制文件（粘贴/拖放插图用）：父目录不存在则创建，写法与文本一致（临时文件 + rename）。
#[tauri::command]
pub fn kb_write_bytes(root: String, rel: String, base64: String) -> Result<Entry, String> {
    write_bytes_in(&root, &rel, &base64).map_err(|e| e.to_string())
}

pub fn write_bytes_in(root: &str, rel: &str, base64: &str) -> Result<Entry> {
    let root_abs = root_path(root)?;
    let normalized = normalize_rel(rel)?;
    if normalized.is_empty() {
        bail!("路径不能为空");
    }
    let abs = resolve_in_root(&root_abs, &normalized)?;
    let bytes = decode_base64(base64)?;
    let dir = abs.parent().ok_or_else(|| anyhow!("无效路径"))?;
    if !dir.exists() {
        std::fs::create_dir_all(dir).context("创建目录失败")?;
    }
    let tmp = dir.join(format!(".hivetask-tmp-{}", std::process::id()));
    std::fs::write(&tmp, &bytes).context("写入临时文件失败")?;
    std::fs::rename(&tmp, &abs).context("替换目标文件失败")?;
    let meta = std::fs::symlink_metadata(&abs).context("读取新文件失败")?;
    let name = normalized
        .rsplit('/')
        .next()
        .ok_or_else(|| anyhow!("无效路径"))?
        .to_string();
    let repo = git2::Repository::discover(&root_abs).ok();
    Ok(Entry {
        rel: normalized,
        name,
        kind: kind_of(&meta),
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
        ignored: is_ignored(repo.as_ref(), &abs),
    })
}

// ---- 打开方式（「用默认程序打开」的应用选择）----
//
// 为什么不用 `tauri-plugin-opener` 的前端 `openPath`：该命令内部强制 ACL scope 校验
// （plugin commands.rs → scope.rs 的 `is_path_allowed` → `fs_scope.is_allowed`），
// 而 Tauri 的 fs scope 是**编译期静态**配置、**空 allow 列表等于全拒**——
// 用户自选的知识库根无法表达成静态 scope，所以那条路径必然拿到 ForbiddenPath。
//
// 这里在 Rust 侧直接调 `OpenerExt::open_path`（Rust 侧无 ACL 限制），
// 同时把两件事握在自己手里：① 路径必须落在知识库根内（复用 resolve_in_root）；
// ② **要启动的程序由 Rust 从 app.db 的偏好里读**，前端不能指定——
// 否则「打开文件」就成了任意程序启动的入口。

/// 打开方式偏好：按扩展名指定应用；**没指定的走系统默认程序**。
///
/// 早期还有一个"全局默认应用"字段（让用户手打应用名）——已随设置页那次改动去掉：
/// 它就等于"给所有扩展名各写一条规则"，却多出一条要用户自己维护、而且**和系统已有的
/// 打开方式对着干**的配置。现在只保留按扩展名覆盖，其余交给 LaunchServices。
/// （旧的 `defaultApp` 字段若存在于 JSON 里会被 serde 忽略，不报错。）
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithPrefs {
    /// 扩展名（小写、不含点）→ 应用（`.app` 绝对路径或应用名）。
    #[serde(default)]
    pub by_ext: std::collections::BTreeMap<String, String>,
}

const OPEN_WITH_KEY: &str = "kb.openWith";

fn open_with_get(conn: &rusqlite::Connection) -> Result<OpenWithPrefs> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM prefs WHERE key = ?1", [OPEN_WITH_KEY], |row| row.get(0))
        .ok();
    Ok(raw
        .and_then(|json| serde_json::from_str::<OpenWithPrefs>(&json).ok())
        .unwrap_or_default())
}

/// 解析某个文件该用哪个应用打开：按扩展名命中就用它，否则空串 = 系统默认程序。
fn app_for(prefs: &OpenWithPrefs, rel: &str) -> String {
    let ext = rel
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext.to_lowercase()))
        .unwrap_or_default();
    prefs
        .by_ext
        .get(&ext)
        .filter(|app| !app.trim().is_empty())
        .cloned()
        .unwrap_or_default()
}

#[tauri::command]
pub fn kb_open_prefs_get() -> Result<OpenWithPrefs, String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    open_with_get(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kb_open_prefs_set(prefs: OpenWithPrefs) -> Result<(), String> {
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&prefs).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO prefs (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![OPEN_WITH_KEY, json, crate::appdb::chrono_like_now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 选择外部程序（「打开方式」用）：macOS 选 `.app`、Windows 选 `.exe`、Linux 选可执行文件。
/// 取消返回 None。
#[tauri::command]
pub async fn kb_pick_app(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_dialog::FilePath;

    let (tx, mut rx) = tauri::async_runtime::channel::<Option<String>>(1);
    window
        .dialog()
        .file()
        .set_title("选择打开方式")
        .pick_file(move |path| {
            let value: Option<String> = path
                .map(|p| match p {
                    FilePath::Path(path_buf) => path_buf.to_string_lossy().to_string(),
                    FilePath::Url(url) => url
                        .to_file_path()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default(),
                })
                .filter(|s| !s.is_empty());
            let _ = tx.blocking_send(value);
        });
    rx.recv().await.ok_or_else(|| "对话框已关闭".to_string())
}

/// 用（配置的）外部程序打开知识库内的文件。
///
/// 未配置任何应用 → 系统默认程序；配置了 → 用它（macOS 为 `open -a <名>` 语义）。
#[tauri::command]
pub fn kb_open_external(
    app: tauri::AppHandle,
    root: String,
    rel: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let root_abs = root_path(&root).map_err(|e| e.to_string())?;
    let abs = resolve_in_root(&root_abs, &rel).map_err(|e| e.to_string())?;
    if !abs.is_file() {
        return Err("文件不存在".into());
    }
    let conn = crate::appdb::open().map_err(|e| e.to_string())?;
    let prefs = open_with_get(&conn).map_err(|e| e.to_string())?;
    let app_name = app_for(&prefs, &rel);

    let path = abs.to_string_lossy().to_string();
    if app_name.trim().is_empty() {
        app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
    } else {
        app.opener()
            .open_path(path, Some(app_name.as_str()))
            .map_err(|e| e.to_string())
    }
}
