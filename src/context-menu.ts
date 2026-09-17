/**
 * 全局右键策略：应用外壳上不弹浏览器味的系统菜单。
 *
 * 背景：WKWebView 对**没有接管右键**的区域会给两张默认菜单——
 * ① dev 构建的开发者页面菜单（Reload / Inspect Element）；
 * ② macOS 的网页文本菜单（Look Up / Translate / Share / Services…）。
 * 它们是 WebView 的默认行为，不是我们的菜单；在桌面应用的外壳（树头、面板头、
 * 状态栏、预览空白）上出现会很"网页味"，正式包里第 ① 张还会变成只有
 * Look Up/Translate 的那半截。
 *
 * 保留系统菜单的例外（那里确实需要系统的剪切/复制/粘贴、查询、服务）：
 * - 可编辑控件：`input / textarea / [contenteditable]`（含 CM6 的 `.cm-content`；
 *   编辑器自己会先 preventDefault 换成我们的命令菜单，这里是给对话框输入框留的）；
 * - 终端（`.xterm`）：右键粘贴是终端里的习惯操作；
 * - 超链接：保留「复制链接地址」这类系统项；
 * - 有选中文本时：PDF / 代码块里选一段再右键，仍能复制或查询。
 *
 * 调试逃生口：按住 ⌥ 或 ⌘ 右键 = 交回 WebView 默认菜单（Inspect Element 在里面）。
 */
export function keepsNativeContextMenu(event: MouseEvent): boolean {
  if (event.altKey || event.metaKey) return true;
  const target = event.target;
  if (target instanceof Element && target.closest("input, textarea, [contenteditable], a[href], .xterm")) {
    return true;
  }
  return (window.getSelection()?.toString().trim().length ?? 0) > 0;
}
