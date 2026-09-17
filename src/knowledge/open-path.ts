/**
 * 用外部程序打开知识库文件 / 在文件管理器中显示。
 *
 * **打开**走我们自己的 `kb_open_external`（不是 `@tauri-apps/plugin-opener` 的 `openPath`）：
 * 后者在命令内部强制 ACL scope 校验，而其 fs scope 是编译期静态配置且**空 allow 即全拒**，
 * 用户自选的知识库根无法表达成静态 scope → 必然拿到 `ForbiddenPath`（已实证）。
 * 自建命令同时把沙箱（必须落在知识库根内）与"用哪个程序"（Rust 从偏好解析）握在自己手里。
 *
 * **显示**走插件：`reveal_item_in_dir` 无 scope 校验（已核对插件源码），可直接用。
 */
import { api, isTauri } from "../api";

export async function openPathWithConfiguredApp(root: string, rel: string): Promise<void> {
  if (!isTauri()) return;
  await api.kbOpenExternal(root, rel);
}

/** 「在文件管理器中显示」——失败**必须冒泡**（调用方弹 toast），静默吞掉会让用户以为点了没用。 */
export async function revealPath(path: string): Promise<void> {
  if (!isTauri()) return;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
}
