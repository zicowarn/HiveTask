//! PTY sessions for the integrated terminal (portable-pty: ConPTY on
//! Windows, forkpty elsewhere). One session per terminal panel instance;
//! output streams to the webview through a Tauri ipc Channel, input comes
//! back through pty_write.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};

use tauri::ipc::Channel;
use tauri::State;

pub struct PtyHandle {
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

/// Shared session table managed by Tauri.
pub struct PtyMap(pub Mutex<HashMap<String, PtyHandle>>);

fn resolve_shell(explicit: Option<String>) -> String {
    if let Some(shell) = explicit.filter(|s| !s.trim().is_empty()) {
        return shell;
    }
    #[cfg(unix)]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
}

const EXIT_MARKER: &str = "\u{1b}[__HIVETASK_PTY_EXIT__]";

#[tauri::command]
pub fn pty_spawn(
    id: String,
    cwd: Option<String>,
    shell: Option<String>,
    rows: u16,
    cols: u16,
    on_output: Channel<String>,
    map: State<PtyMap>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .context("创建 PTY 失败")
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(resolve_shell(shell));
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.cwd(dir);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).context("启动 shell 失败").map_err(|e| e.to_string())?;
    let mut reader =
        pair.master.try_clone_reader().context("克隆 PTY 读取端失败").map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().context("获取 PTY 写入端失败").map_err(|e| e.to_string())?;

    // The slave's copy in the handle must be dropped before the reader
    // sees EOF on some platforms; master stays for write/resize.
    drop(pair.slave);

    let handle = PtyHandle { writer, child, master: pair.master };
    if map.0.lock().unwrap().insert(id.clone(), handle).is_some() {
        // Stale session with the same id (HMR remount): kill the old one.
        if let Some(mut old) = map.0.lock().unwrap().remove(&id) {
            let _ = old.child.kill();
        }
    }

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if on_output.send(String::from_utf8_lossy(&buf[..n]).to_string()).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = on_output.send(EXIT_MARKER.to_string());
    });

    Ok(())
}

#[tauri::command]
pub fn pty_write(id: String, data: String, map: State<PtyMap>) -> Result<(), String> {
    let mut map = map.0.lock().unwrap();
    let handle = map.get_mut(&id).ok_or_else(|| "会话不存在".to_string())?;
    handle.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(id: String, rows: u16, cols: u16, map: State<PtyMap>) -> Result<(), String> {
    let map = map.0.lock().unwrap();
    let handle = map.get(&id).ok_or_else(|| "会话不存在".to_string())?;
    handle
        .master
        .resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(id: String, map: State<PtyMap>) -> Result<(), String> {
    if let Some(mut handle) = map.0.lock().unwrap().remove(&id) {
        let _ = handle.child.kill();
    }
    Ok(())
}
