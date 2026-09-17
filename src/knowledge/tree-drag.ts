/**
 * 文件树的**拖拽移动**：状态与判定逻辑。
 *
 * ⚠️ 关键决策：**不用 HTML5 拖放 API，改用手势（pointer）事件自己实现。**
 * 取证来自 SoloMD `composables/useTreeDrag.ts` 的注释（MIT，计划里指定的树骨架参照）：
 * Tauri 的原生拖放处理会**吞掉页面内拖拽** —— `dragstart` 照常触发（所以看起来"能拖"），
 * 但 `dragover` / `drop` 永远到不了，直到你真去放东西才会发现。他们为此重写过两次
 * （#86 页签排序、#131 侧栏排序）。我们仓库同样踩过这个坑（`tauri.conf.json` 里的
 * `dragDropEnabled: false` 就是当时的修法）—— 与其赌那个开关，不如用手势事件：
 * 它不受引擎与原生处理影响，行为完全可控。
 *
 * 拖拽状态放在**模块级**（同 SoloMD 的理由）：树是递归组件，节点与树本体都要读同一份
 * 拖拽状态，用 prop 逐层传会很啰嗦。
 */
import { ref } from "vue";

/** 正在拖的项（多选时是整批）。 */
export const dragPaths = ref<string[]>([]);
/** 当前高亮的落点目录（"" = 根；null = 没有合法落点）。 */
export const dropDir = ref<string | null>(null);
/** 落点是"某文件所在目录"时，插入线画在这个文件上（VS Code 同款形态）。 */
export const dropBefore = ref<string | null>(null);
/** 真拖过之后吃掉紧随其后的那次 click（否则会顺手把文件打开/目录折叠）。 */
export const suppressClick = ref(false);

export function endDrag(): void {
  dragPaths.value = [];
  dropDir.value = null;
  dropBefore.value = null;
}

/** 父目录（"" 表示根下的项）。 */
export function parentOf(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at < 0 ? "" : rel.slice(0, at);
}

/** 取路径末段（文件名）。 */
export function baseName(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at < 0 ? rel : rel.slice(at + 1);
}

/** 拼子路径（根下的项不带前导斜杠）。 */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/**
 * 能否把 `from` 放进目录 `destDir`。拒绝的三种情况（与 SoloMD 的 `canDropInto` 同口径）：
 * - 放进自己所在的目录（无意义的空操作，还会白闪一下提示）；
 * - 放进自己（目录拖到自己身上）；
 * - 放进自己的子孙目录（操作系统层面本来也会拒绝）。
 */
export function canDropInto(from: string, destDir: string): boolean {
  if (!from || destDir === null || destDir === undefined) return false;
  if (destDir === from) return false;
  if (parentOf(from) === destDir) return false;
  if (destDir.startsWith(`${from}/`)) return false;
  return true;
}

/** 一批拖动项里，至少有一个能放进 `destDir`（决定是否显示落点反馈）。 */
export function anyDroppable(paths: string[], destDir: string): boolean {
  return paths.some((path) => canDropInto(path, destDir));
}

/** 实际要移动的项（过滤掉不合法的）。 */
export function droppablePaths(paths: string[], destDir: string): string[] {
  return paths.filter((path) => canDropInto(path, destDir));
}

/**
 * 命中一个树行时，落点目录怎么算：
 * - 行是目录 → 放进它；
 * - 行是文件 → 放进它所在的目录，并在该行上画插入线（名字排序下的"插到这儿"）。
 *   这条与 VS Code 一致：把文件拖到另一个文件上，效果是"进同一个目录"。
 */
export function resolveDropTarget(row: { rel: string; kind: "file" | "dir" } | null): {
  dir: string;
  before: string | null;
} {
  if (!row) return { dir: "", before: null };
  if (row.kind === "dir") return { dir: row.rel, before: null };
  return { dir: parentOf(row.rel), before: row.rel };
}
