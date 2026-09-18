//! 知识库根目录的**外部改动侦测**（T10 watcher）。
//!
//! 为什么用**轮询 mtime 快照**而不是 `notify` crate：
//! - crates.io 在当前环境不可达（SSL 错误），加不了依赖；
//! - 知识库是单根、规模有限（数百到千级文件），2 秒全量扫一遍 mtime 的开销可忽略
//!   （`stat` 每个文件微秒级）；
//! - 轮询天然覆盖所有变更类型（改/建/删/改名/分支切换），不需要处理 notify 的各种平台怪癖。
//!
//! 事件只发**一个去抖的信号**（`kb://changed`），前端收到后按需刷新树与预览 ——
//! 不传变更明细，避免"每改一个字就发一条"的洪水。
//!
//! 生命周期：`kb_watch_start` 启动对当前根的监听（换根时重新调用）；后台线程在
//! 根失效（被移动/删除）后自动退出。`kb_watch_stop` 停止（前端切换工作区时调用，
//! 避免后台空转）。
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Emitter;

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// 全局 watcher 代际：每次 start 递增，旧线程看到代际变化自行退出。
static WATCH_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 快照：相对路径 → mtime（毫秒）。目录也参与（检测"目录被删"与"目录改名"）。
type Snapshot = HashMap<String, i64>;

/// 递归收集快照（跳过 .git 与符号链接，与树口径一致；默认排除项同树）。
fn collect_snapshot(root: &PathBuf, snapshot: &mut Snapshot) {
    const DEFAULT_EXCLUDES: &[&str] = &[".git", ".svn", ".hg", "CVS", "node_modules", "target"];
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let abs = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if DEFAULT_EXCLUDES.contains(&name.as_str()) {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(&abs) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        let Ok(rel) = abs.strip_prefix(root) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        snapshot.insert(rel, mtime);
        if meta.is_dir() {
            collect_snapshot(&abs, snapshot);
        }
    }
}

/// 启动对知识库根的监听。每次调用都会**替换**上一个 watcher（代际 +1，旧线程退出）。
#[tauri::command]
pub fn kb_watch_start(app: tauri::AppHandle, root: String) -> Result<(), String> {
    let root_abs = crate::kb::root_path(&root).map_err(|e| e.to_string())?;
    let generation = WATCH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    let handle = app.clone();
    std::thread::spawn(move || {
        let mut last: Snapshot = HashMap::new();
        collect_snapshot(&root_abs, &mut last);

        loop {
            // 代际变了 = 有新 watcher 接班（或已 stop），本线程退场
            if WATCH_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            std::thread::sleep(Duration::from_millis(2000));

            let mut now: Snapshot = HashMap::new();
            collect_snapshot(&root_abs, &mut now);

            // 根消失：发一次信号后退出（前端会显示"文件夹不存在"空态）
            if !root_abs.is_dir() {
                let _ = handle.emit("kb://changed", "root-missing");
                return;
            }

            // 快照不同 → 去抖发信号；把新快照记为基线（连续改动只发一条）
            if now != last {
                last = now;
                let _ = handle.emit("kb://changed", "changed");
            }
        }
    });
    Ok(())
}

/// 停止监听（前端切走知识库工作区时调用，后台线程不再空转）。
#[tauri::command]
pub fn kb_watch_stop() -> Result<(), String> {
    WATCH_GENERATION.fetch_add(1, Ordering::SeqCst);
    Ok(())
}
