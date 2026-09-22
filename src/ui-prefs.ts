/**
 * 「工作内容」级 UI 偏好的持久化桥：**app.db 是真理，localStorage 是本安装形态的镜像**。
 *
 * 为什么要有这一层（2026-09-22 用户定案：安装版必须是正式的家）：
 * webview 的 localStorage **按「安装形态 + 来源」分库**——开发态是裸二进制
 * （`~/Library/WebKit/<进程名>`、来源 `http://localhost:1420`），装成 .app 后目录名按
 * bundle id、来源变 `tauri://localhost`。同一台机器上这就是两份库：用户辛苦攒的
 * 知识库根、项目视图配置、工作台布局，在安装版里会"消失"。而 app.db 的路径由 Rust 常量
 * 决定，与安装形态无关——所以凡是「我的工作内容指向」都上提到那里。
 *
 * **划线（不是"全都搬"）**：
 * - 走 app.db：知识库根与最近文件、项目视图配置、工作台布局、分支 review 的 base、
 *   最近仓库（后两者真源本就在别处，这里是便利缓存）。
 * - 留在 localStorage：主题 / 语言 / 终端 shell / 同步间隔 / 农历副行 / 各类面板 Mode /
 *   工作区选择——**这台机器上的偏好**，换机或重装随手重选即可，不值得跨机同步。
 *
 * 镜像策略：启动时 `hydrateDurablePrefs()` 把 app.db 的值灌进 localStorage（既有同步读取点
 * 因此不必改成异步）；写入走 `setDurablePref()`，两边都写。浏览器预览没有 app.db，
 * 直接落 localStorage（那条路径本来就不进安装版）。
 */
import { api, isTauri } from "./api";

/** 走 app.db 的键前缀（与 Rust 侧 `ui_prefs::UI_PREFIX` 命名空间对应）。 */
const DURABLE_PREFIXES = [
  "hivetask.kb.", // 知识库：root / recent / recentFiles / view / treeRatio / showIgnored
  "hivetask.project-view", // 项目视图配置（view 与 views 两族都以此开头）
  "hivetask.workbench-layout-v1",
  "hivetask.branchreview.base.",
  "hivetask.lastRepo",
  "hivetask.recentRepos",
];

/** 该键是否属于「工作内容」（要走 app.db）。 */
export function isDurableKey(key: string): boolean {
  return DURABLE_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * 启动时的镜像计划（纯函数，便于单测）：
 * - app.db 里有的 → **覆盖**镜像（app.db 是真理；安装版第一次启动就靠它把值灌回来）；
 * - app.db 没有、但镜像里有 → **上搬**（升级路径：老用户的 localStorage 攒的值进库）；
 * - 两边都没有 → 不管。
 */
export function planHydration(
  dbPairs: [string, string][],
  localPairs: [string, string | null][],
): { mirror: [string, string][]; upload: [string, string][] } {
  const db = new Map(dbPairs);
  const local = new Map(localPairs);
  const mirror: [string, string][] = [];
  const upload: [string, string][] = [];
  for (const [key, value] of db) {
    if (local.get(key) !== value) mirror.push([key, value]);
  }
  for (const [key, value] of local) {
    if (value !== null && !db.has(key) && isDurableKey(key)) upload.push([key, value]);
  }
  return { mirror, upload };
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 存储不可用 → 本次会话仍可用（镜像丢了，app.db 还在）
  }
}

/** 启动时调用一次（`main.ts`，挂载前——store 的首读都发生在挂载之后）。 */
export async function hydrateDurablePrefs(): Promise<void> {
  if (!isTauri()) return;
  try {
    // 通道不可用 → 空表：此时"库"里什么都没有，下面的上搬会把镜像里的值带进去
    const dbPairs = (await api.uiPrefsGetAll?.()) ?? [];
    const localPairs: [string, string | null][] = dbPairs.map(([k]) => [k, readLocal(k)]);
    // 上搬还要看镜像里 app.db 没有的那些键
    const extra: [string, string | null][] = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && isDurableKey(key) && !dbPairs.some(([k]) => k === key)) {
          extra.push([key, readLocal(key)]);
        }
      }
    } catch {
      // 读不到 localStorage 的长度/键名 → 跳过上搬（镜像仍会被灌）
    }
    const { mirror, upload } = planHydration(dbPairs, [...localPairs, ...extra]);
    for (const [key, value] of mirror) writeLocal(key, value);
    for (const [key, value] of upload) {
      try {
        void api.uiPrefsSet?.(key, value)?.catch?.(() => {});
      } catch {
        // 上搬失败不阻塞启动（下一次启动会重试）
      }
    }
  } catch {
    // 读不到就退化为"纯 localStorage 模式"——不阻塞启动
  }
}

/** 读（同步；镜像口径）。 */
export function durableGet(key: string): string | null {
  return readLocal(key);
}

/**
 * 写：镜像立刻更新（同步 UI 体验），app.db 异步落盘（那条才是安装版/换机后的真源）。
 * 删值（null）同样两边都删。
 */
export function durableSet(key: string, value: string | null): void {
  writeLocal(key, value);
  if (!isTauri()) return;
  // 落库是尽力而为：镜像已经更新（同步效果成立），命令通道缺失/失败都不该
  // 反噬调用方（测试替身与降级环境里这条通道可能不存在）。
  try {
    const req = value === null ? api.uiPrefsRemove?.(key) : api.uiPrefsSet?.(key, value);
    void req?.catch(() => {});
  } catch {
    // 通道不可用 → 本次会话用镜像，app.db 那份下次启动由上搬补齐
  }
}
