/**
 * 应用级确认框。
 *
 * **不要用 `window.confirm`**：wry / WKWebView 没实现 JS 对话框（wry 0.55.1 的
 * `src/wkwebview` 里没有 `runJavaScriptConfirmPanel` 的实现），`confirm()` 既不弹框
 * 又恒返回 true——删除类动作会在**没有任何询问**的情况下直接执行。实测：知识库树
 * 右键「删除」点下去 0.8s 内文件即进回收站，全程无对话框，代码里的
 * `if (!confirm(...)) return` 形同虚设。
 *
 * Tauri 侧改走 dialog 插件的原生确认框（`plugin:dialog|message`；`dialog:default`
 * 已含 `allow-message`），浏览器预览降级回 `window.confirm`（那里是好的）。
 */
import { isTauri } from "./api";

export interface ConfirmOptions {
  /** 原生对话框标题（macOS 显示为加粗首行）。 */
  title?: string;
  okLabel?: string;
  cancelLabel?: string;
}

/** 询问用户是否继续；返回 false 表示取消。 */
export async function confirmAction(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  if (!isTauri()) return window.confirm(message);
  const { confirm } = await import("@tauri-apps/plugin-dialog");
  return confirm(message, {
    title: options.title,
    kind: "warning",
    okLabel: options.okLabel,
    cancelLabel: options.cancelLabel,
  });
}
