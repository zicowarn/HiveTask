//! OS 钥匙串凭据存取（macOS 钥匙串 / Windows 凭据管理器 / Linux Secret
//! Service）。token 永不进 localStorage 或明文文件——gh 的 hosts.yml 明文
//! 先例在此刻意不沿用，桌面 GUI 有条件做对。
//!
//! service 命名 `hivetask.<platform>`（如 hivetask.gitea），一个平台一个
//! 条目，host 等非敏感配置另存设置。dev 未签名二进制首次访问会弹一次
//! 钥匙串授权，属预期。

use anyhow::Context as _;

const SERVICE_PREFIX: &str = "hivetask";

fn entry(platform: &str) -> anyhow::Result<keyring::Entry> {
    // platform 白名单：future Gitee/GitLab 直接扩表
    match platform {
        "gitea" | "gitee" | "gitlab" => {}
        other => return Err(anyhow::anyhow!("未知的来源平台: {other}")),
    }
    keyring::Entry::new(&format!("{SERVICE_PREFIX}.{platform}"), "token")
        .context("创建钥匙串条目失败")
}

#[tauri::command]
pub fn credential_set(platform: String, token: String) -> Result<(), String> {
    let e = entry(&platform).map_err(|e| e.to_string())?;
    e.set_password(&token).map_err(|err| err.to_string())
}

/// 返回 Option 语义：None = 未设置。查询失败（含用户拒绝钥匙串）统一为
/// Err——UI 显示「未配置」即可，不区分原因。
#[tauri::command]
pub fn credential_get(platform: String) -> Result<Option<String>, String> {
    let e = entry(&platform).map_err(|e| e.to_string())?;
    match e.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub fn credential_delete(platform: String) -> Result<(), String> {
    let e = entry(&platform).map_err(|e| e.to_string())?;
    // 未设置过也视为删除成功（幂等）。
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}
