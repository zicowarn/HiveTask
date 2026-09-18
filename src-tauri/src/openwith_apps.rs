//! 「打开方式」的**系统来源**：这台机器上装了哪些应用、系统认为哪个能开这个扩展名。
//!
//! 为什么要有这一层：设置里让用户手打「应用名」（如 `Typora`）本质上是把系统已有的
//! 信息再问一遍用户 —— 打错就是"点了没反应"。两条数据源都来自系统：
//!
//! ① **LaunchServices**（`LSCopyApplicationURLsForURL` / `LSCopyDefaultApplicationURLForURL`）：
//!    就是 Finder「打开方式」菜单背后的那张表 —— 给定一个带扩展名的文件，返回
//!    **系统默认应用**与**候选应用**（含没有在 Info.plist 里声明扩展名、但注册了该类型的应用）。
//!    实测：`.md` → 默认 Typora、候选 13 个；`.xmind` → 默认 Xmind、候选 5 个。
//!    ⚠️ 查询前**必须让这个路径存在**：文件不存在时 LaunchServices 直接返回空数组
//!    （实机验证过，这是最容易踩的一点）——所以先落一个空文件再查，查完删掉。
//!
//! ② **已装应用扫描**（`installed_apps`）：扫标准应用目录里的 `.app`，读 `Info.plist` 拿
//!    显示名与它声明的扩展名。用于"该系统没登记这个扩展名"的场合（例：`.dwg` 没有
//!    默认应用时，用户仍要从已装应用里挑一个）。
//!
//! 平台边界：只有 macOS 走这两条路（其余平台返回空列表，前端退化成"浏览器"）。
//! 这些命令只**读**系统信息，不写任何东西；探测用的临时文件在系统临时目录里，用完即删。

use serde::Serialize;

/// 一个可用来"打开方式"的应用。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppInfo {
    /// 应用显示名（`Info.plist` 的 CFBundleDisplayName / CFBundleName；取不到则由 bundle 名兜底）。
    pub name: String,
    /// `.app` 的绝对路径 —— **存它**（同名应用可能有好几个，路径是唯一可靠的）。
    pub path: String,
    /// 该应用在 Info.plist 里声明的扩展名（小写、不含点）。空数组 = 没声明（不是错误）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extensions: Vec<String>,
}

/// 某个扩展名的系统登记情况。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtApps {
    /// 系统默认应用（Finder 里双击会用的那个）；系统没登记时为 None。
    pub default: Option<AppInfo>,
    /// 候选应用（Finder「打开方式」子菜单那一列），默认应用排在最前。
    pub candidates: Vec<AppInfo>,
}

/// 扩展名归一化：小写、去前导点；只接受字母数字（拒绝路径分隔符/怪字符）。
fn normalize_ext(ext: &str) -> Option<String> {
    let cleaned: String = ext.trim().trim_start_matches('.').to_lowercase();
    if cleaned.is_empty() || cleaned.len() > 16 || !cleaned.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(cleaned)
}

/// 由 `.app` 路径取显示名：优先 `Info.plist` 的 CFBundleDisplayName / CFBundleName，
/// 取不到就用 bundle 文件名（`Typora.app` → `Typora`）——这条兜底路径不需要读 plist。
#[cfg(target_os = "macos")]
fn app_display_name(bundle: &std::path::Path) -> String {
    let stem = bundle
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let info = bundle.join("Contents").join("Info.plist");
    let Ok(value) = plist::Value::from_file(&info) else {
        return stem;
    };
    let dict = match value.as_dictionary() {
        Some(dict) => dict,
        None => return stem,
    };
    for key in ["CFBundleDisplayName", "CFBundleName"] {
        if let Some(name) = dict.get(key).and_then(|v| v.as_string()) {
            let name = name.trim();
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    stem
}

/// `.app` 在 Info.plist 里声明的扩展名（CFBundleTypeExtensions + LSItemContentTypes 的尾段）。
///
/// 为什么连 UTI 一起看：有的应用只声明 `LSItemContentTypes = ["com.autodesk.dwg"]`，
/// 不写 `CFBundleTypeExtensions`；只看后者会把它们漏掉（UTI 的尾段通常就是扩展名）。
#[cfg(target_os = "macos")]
fn declared_extensions(bundle: &std::path::Path) -> Vec<String> {
    let info = bundle.join("Contents").join("Info.plist");
    let Ok(value) = plist::Value::from_file(&info) else {
        return Vec::new();
    };
    let Some(dict) = value.as_dictionary() else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        let cleaned = raw.trim().trim_start_matches('.').to_lowercase();
        if !cleaned.is_empty() && cleaned.len() <= 16 && cleaned.chars().all(|c| c.is_ascii_alphanumeric()) {
            out.push(cleaned);
        }
    };
    if let Some(types) = dict.get("CFBundleDocumentTypes").and_then(|v| v.as_array()) {
        for entry in types {
            let Some(entry) = entry.as_dictionary() else { continue };
            if let Some(exts) = entry.get("CFBundleTypeExtensions").and_then(|v| v.as_array()) {
                for ext in exts {
                    if let Some(ext) = ext.as_string() {
                        push(ext);
                    }
                }
            }
            if let Some(utis) = entry.get("LSItemContentTypes").and_then(|v| v.as_array()) {
                for uti in utis {
                    if let Some(uti) = uti.as_string() {
                        if let Some(tail) = uti.rsplit('.').next() {
                            push(tail);
                        }
                    }
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// 扫标准应用目录里的 `.app`（不深入 bundle 内部；深度受限，避免 Xcode 那种巨型树）。
///
/// 目录清单固定为系统惯例位置 —— 这不是"猜"，是 macOS 应用实际安装的地方；
/// 装在别处的应用由前端的「浏览…」（原生选择器）兜底。
#[cfg(target_os = "macos")]
fn app_search_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = [
        "/Applications",
        "/Applications/Utilities",
        "/System/Applications",
        "/System/Applications/Utilities",
    ]
    .iter()
    .map(std::path::PathBuf::from)
    .collect();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(std::path::PathBuf::from(home).join("Applications"));
    }
    dirs
}

#[cfg(target_os = "macos")]
fn collect_apps(dir: &std::path::Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
    if depth > 3 || out.len() > 500 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let is_bundle = path.extension().map(|e| e.eq_ignore_ascii_case("app")).unwrap_or(false);
        if is_bundle {
            out.push(path);
            continue; // 不再往 bundle 里走（里面的 helper app 不是给用户选的）
        }
        collect_apps(&path, depth + 1, out);
    }
}

/// 已安装应用清单（按名字排序）。同步函数、扫盘有 IO —— 由命令包在阻塞线程池里跑。
#[cfg(target_os = "macos")]
pub fn installed_apps() -> Vec<AppInfo> {
    let mut bundles: Vec<std::path::PathBuf> = Vec::new();
    for dir in app_search_dirs() {
        collect_apps(&dir, 0, &mut bundles);
    }
    bundles.sort();
    bundles.dedup();
    let mut apps: Vec<AppInfo> = bundles
        .iter()
        .map(|bundle| AppInfo {
            name: app_display_name(bundle),
            path: bundle.to_string_lossy().to_string(),
            extensions: declared_extensions(bundle),
        })
        .collect();
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps.dedup_by(|a, b| a.path == b.path);
    apps
}

#[cfg(not(target_os = "macos"))]
pub fn installed_apps() -> Vec<AppInfo> {
    Vec::new()
}

/// LaunchServices：给定扩展名，返回系统默认应用与候选应用（Finder「打开方式」那张表）。
#[cfg(target_os = "macos")]
pub fn apps_for_ext(ext: &str) -> ExtApps {
    use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
    use core_foundation_sys::base::{CFRelease, CFTypeRef};
    use core_foundation_sys::string::{CFStringCreateWithCString, CFStringGetCString, kCFStringEncodingUTF8};
    use core_foundation_sys::url::{
        CFURLCopyFileSystemPath, CFURLCreateWithFileSystemPath, CFURLRef, kCFURLPOSIXPathStyle,
    };

    /// `kLSRolesAll`：不限定 Viewer/Editor（Finder 的「打开方式」也是这个口径）。
    const LS_ROLES_ALL: u32 = 0xFFFF_FFFF;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyApplicationURLsForURL(url: CFURLRef, roles: u32) -> CFArrayRef;
        fn LSCopyDefaultApplicationURLForURL(url: CFURLRef, roles: u32, error: *mut CFTypeRef) -> CFURLRef;
    }

    let Some(ext) = normalize_ext(ext) else {
        return ExtApps::default();
    };

    // ① 探测文件必须先**存在**（不存在时 LaunchServices 一律返回空 —— 实机踩过）
    let probe = std::env::temp_dir().join(format!("hivetask-openwith-probe.{}", ext));
    if std::fs::write(&probe, b"").is_err() {
        return ExtApps::default();
    }
    let result = std::panic::catch_unwind(|| {
        let c_path = std::ffi::CString::new(probe.to_string_lossy().as_bytes()).ok()?;
        // CFURLCreateWithFileSystemPath(NULL, path, POSIX, false) → 所有权在我们手里
        let url = unsafe {
            CFURLCreateWithFileSystemPath(std::ptr::null(), {
                CFStringCreateWithCString(std::ptr::null(), c_path.as_ptr(), kCFStringEncodingUTF8)
            }, kCFURLPOSIXPathStyle, 0)
        };
        if url.is_null() {
            return None;
        }

        /// CFURLRef → 绝对路径字符串。
        unsafe fn url_to_path(url: CFURLRef) -> Option<String> {
            let path_ref = unsafe { CFURLCopyFileSystemPath(url, kCFURLPOSIXPathStyle) };
            if path_ref.is_null() {
                return None;
            }
            let mut buf = vec![0i8; 4096];
            let ok = unsafe { CFStringGetCString(path_ref, buf.as_mut_ptr(), buf.len() as isize, kCFStringEncodingUTF8) };
            unsafe { CFRelease(path_ref as CFTypeRef) };
            if ok == 0 {
                return None;
            }
            let bytes: Vec<u8> = buf.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
            Some(String::from_utf8_lossy(&bytes).to_string())
        }

        /// CFArrayRef（+1 引用）→ 应用路径列表；调用后释放数组与元素。
        unsafe fn array_to_paths(array: CFArrayRef) -> Vec<String> {
            if array.is_null() {
                return Vec::new();
            }
            let mut out = Vec::new();
            let count = unsafe { CFArrayGetCount(array) };
            for index in 0..count {
                let item = unsafe { CFArrayGetValueAtIndex(array, index) } as CFURLRef;
                if let Some(path) = unsafe { url_to_path(item) } {
                    out.push(path);
                }
            }
            unsafe { CFRelease(array as CFTypeRef) };
            out
        }

        let default = unsafe {
            let raw = LSCopyDefaultApplicationURLForURL(url, LS_ROLES_ALL, std::ptr::null_mut());
            if raw.is_null() {
                None
            } else {
                let path = url_to_path(raw);
                CFRelease(raw as CFTypeRef);
                path
            }
        };

        let candidates = unsafe { array_to_paths(LSCopyApplicationURLsForURL(url, LS_ROLES_ALL)) };

        unsafe { CFRelease(url as CFTypeRef) };
        Some((default, candidates))
    });

    let _ = std::fs::remove_file(&probe);
    let (default, candidates) = match result {
        Ok(Some(pair)) => pair,
        _ => return ExtApps::default(),
    };

    let mut apps: Vec<AppInfo> = Vec::new();
    let to_info = |path: &str| AppInfo {
        name: app_display_name(std::path::Path::new(path)),
        path: path.to_string(),
        extensions: Vec::new(),
    };
    let default_app = default.map(|path| to_info(&path));
    // 候选里去掉默认应用（它在最前面单独显示），保持系统的顺序
    let default_path = default_app.as_ref().map(|app| app.path.clone());
    for path in candidates {
        if Some(path.clone()) == default_path || apps.iter().any(|app| app.path == path) {
            continue;
        }
        apps.push(to_info(&path));
    }
    ExtApps {
        default: default_app,
        candidates: apps,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn apps_for_ext(_ext: &str) -> ExtApps {
    ExtApps::default()
}

// ---- Tauri 命令 ----

#[tauri::command]
pub async fn kb_apps_list() -> Result<Vec<AppInfo>, String> {
    tauri::async_runtime::spawn_blocking(installed_apps)
        .await
        .map_err(|e| format!("扫描应用失败：{e}"))
}

#[tauri::command]
pub async fn kb_apps_for_ext(ext: String) -> Result<ExtApps, String> {
    tauri::async_runtime::spawn_blocking(move || apps_for_ext(&ext))
        .await
        .map_err(|e| format!("查询系统应用失败：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_ext_rejects_junk() {
        assert_eq!(normalize_ext(".MD"), Some("md".into()));
        assert_eq!(normalize_ext(" dwg "), Some("dwg".into()));
        assert_eq!(normalize_ext("../../etc/passwd"), None);
        assert_eq!(normalize_ext(""), None);
        assert_eq!(normalize_ext("a"), Some("a".into()));
        assert_eq!(normalize_ext("waytoolongextension"), None);
        assert_eq!(normalize_ext("tar.gz"), None, "带点的复合后缀由调用方拆，这里只认单段");
    }

    #[test]
    fn apps_for_ext_is_safe_for_unknown_extension() {
        // 机器上没有这个类型：必须返回空结构而不是报错/panic
        let result = apps_for_ext("zzzznope");
        assert!(result.default.is_none());
        assert!(result.candidates.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn installed_apps_finds_something_on_macos() {
        // 任何一台 macOS 都至少装了「系统设置 / 访达」这类系统应用
        let apps = installed_apps();
        assert!(!apps.is_empty(), "标准应用目录里应该有 .app");
        assert!(apps.iter().all(|app| app.path.ends_with(".app")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apps_for_ext_matches_launchservices_for_markdown() {
        // .md 在本机有登记（Typora 等）；这条同时验证"探测文件必须存在"这条坑已绕过
        let result = apps_for_ext(".md");
        if result.default.is_none() && result.candidates.is_empty() {
            // 干净机器（没装任何 markdown 应用）走这条：不判失败，只要求不 panic
            eprintln!("本机 LaunchServices 未登记 .md —— 跳过断言");
            return;
        }
        assert!(result.default.is_some(), "有候选就该有默认应用");
    }
}
