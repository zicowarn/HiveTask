//! 全局来源配置（app 级、跨仓库）：目前只有 Gitea 的 host。
//! 存 `~/.config/hivetask/source.json`——Rust 侧 source_for 需要在命令
//! 内同步读取，因此放文件而非 webview localStorage（与 keyring 同理：
//! 认证与来源解析属实现/构造层）。token 不在此文件——它在 OS 钥匙串
//! （credentials.rs）。

use anyhow::Context as _;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SourceConfig {
    pub gitea_host: Option<String>,
}

fn config_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".config").join("hivetask").join("source.json"))
}

pub fn load() -> SourceConfig {
    let Some(path) = config_path() else { return SourceConfig::default() };
    let Ok(raw) = std::fs::read_to_string(&path) else { return SourceConfig::default() };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save(config: &SourceConfig) -> anyhow::Result<()> {
    let Some(path) = config_path() else { return Ok(()) };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("创建配置目录失败")?;
    }
    let json = serde_json::to_string_pretty(config)?;
    std::fs::write(&path, json).with_context(|| format!("写配置失败: {}", path.display()))?;
    Ok(())
}

#[tauri::command]
pub fn source_config_get() -> SourceConfig {
    load()
}

#[tauri::command]
pub fn source_config_set(config: SourceConfig) -> Result<(), String> {
    save(&config).map_err(|e| e.to_string())
}
