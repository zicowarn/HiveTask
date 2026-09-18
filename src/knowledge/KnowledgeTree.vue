<script setup lang="ts">
/**
 * 文件树：根标识 + 懒加载列表 + VS Code 侧栏动作 + 「⋯」视图菜单 + 过滤条。
 *
 * 根标识是**纯展示**，不再是切换入口——切换知识库与「切换仓库 / 切换项目」
 * 同处 App header，这里再来一个下拉会让人以为有两处入口。
 * 「显示被忽略的文件」与「过滤」收进 ⋯ 菜单（本项目既有原语 ActionMenu）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import ActionMenu, { type ActionItem } from "../components/ActionMenu.vue";
import { api } from "../api";
import { confirmAction } from "../confirm";
import { openPathWithConfiguredApp, revealPath } from "./open-path";
import KnowledgeRenameDialog from "./KnowledgeRenameDialog.vue";
import { pushToast } from "../toast";
import EditorIcon from "../components/EditorIcon.vue";
import { useI18n } from "../i18n";
import { useKnowledgeStore } from "../stores/knowledge";
import type { KbEntry } from "../api";
import KnowledgeTreeNode from "./KnowledgeTreeNode.vue";
import {
  anyDroppable,
  baseName,
  dragPaths,
  dropBefore,
  dropDir,
  endDrag,
  joinPath,
  parentOf,
  resolveDropTarget,
  suppressClick,
} from "./tree-drag";

const store = useKnowledgeStore();
const rootEl = ref<HTMLElement | null>(null);
const { t } = useI18n();

const emit = defineEmits<{
  create: [payload: { kind: "file" | "dir"; parent?: string }];
  /** 查看单文件提交历史（由工作台打开抽屉）。 */
  fileHistory: [rel: string];
}>();

// ---- 树节点右键菜单（文件动作的第一落点；重命名/删除等后续并入同一菜单）----
const nodeMenu = ref<{ entry: KbEntry; x: number; y: number } | null>(null);
/** 正在重命名的条目（null = 关闭对话框）。 */
const renameTarget = ref<string | null>(null);

/**
 * 右键的目标集合：若点在**已选中**的项上，就对整个选中集操作（VS Code 语义）；
 * 否则只操作这一项（并把它设为选中）。
 */
const menuTargets = computed<string[]>(() => {
  const entry = nodeMenu.value?.entry;
  if (!entry) return [];
  if (store.selection.length > 1 && store.isSelected(entry.rel)) return [...store.selection];
  return [entry.rel];
});

/** 批量时文案带数量（「删除 3 项」），单项时保持原文案。 */
function labelFor(single: string, many: string, count: number): string {
  type Key = Parameters<typeof t>[0];
  return count > 1 ? t(many as Key, { n: count }) : t(single as Key);
}

const nodeMenuItems = computed<ActionItem[]>(() => {
  const entry = nodeMenu.value?.entry;
  if (!entry) return [];
  const isDir = entry.kind === "dir";
  const count = menuTargets.value.length;
  const batch = count > 1;
  const items: ActionItem[] = [];
  // 多选时只给"对整批有意义"的动作：打开/默认应用打开/路径/历史这些是单文件语义，
  // 硬留着会让人以为只作用于其中某一个（宁可少给，不给错的）
  if (batch) {
    items.push({ value: "copy", label: labelFor("kb.actCopy", "kb.actCopyMany", count), icon: "o.copy", group: t("kb.menuEdit") });
    items.push({ value: "cut", label: labelFor("kb.actCut", "kb.actCutMany", count), icon: "cut", group: t("kb.menuEdit") });
    items.push({ value: "moveTo", label: labelFor("kb.actMoveTo", "kb.actMoveToMany", count), icon: "o.arrow-right", group: t("kb.menuManage") });
    items.push({ value: "delete", label: labelFor("kb.actDelete", "kb.actDeleteMany", count), icon: "o.trash", danger: true, group: t("kb.menuManage") });
    return items;
  }
  // ① 打开类（**我们的差异**：参照项目单击即打开，不需要菜单项；我们的单击是选中/预览，
  //    所以"在编辑器打开"与"默认应用打开"必须给菜单入口 —— ③适配，已标注）
  if (!isDir) {
    items.push({ value: "open", label: t("kb.actOpen"), icon: "o.markdown" });
    items.push({ value: "openExternal", label: t("kb.openWithDefault"), icon: "o.link-external" });
  }
  // ② 新建（SoloMD：仅根/目录上给；文件上给也要落到其父目录，故这里都保留）
  items.push({ value: "newFile", label: t("kb.actNewFile"), icon: "c.new-file", group: t("kb.menuFile") });
  items.push({ value: "newFolder", label: t("kb.actNewFolder"), icon: "c.new-folder", group: t("kb.menuFile") });
  // ③ 剪贴板三件（MarkText 的分组：复制 / 剪切 / 粘贴；粘贴无内容时禁用）
  items.push({ value: "copy", label: t("kb.actCopy"), icon: "o.copy", group: t("kb.menuEdit") });
  items.push({ value: "cut", label: t("kb.actCut"), icon: "cut", group: t("kb.menuEdit") });
  // 粘贴落到"这个目录"（文件则落其父目录）——与两参照一致；
  // 无可粘贴内容时不出现（MarkText 是置灰，我们用"不出现"，避免点了没反应的空控件）
  if (store.clipboard) {
    items.push({
      value: "paste",
      label: t("kb.actPaste"),
      icon: "o.paste",
      group: t("kb.menuEdit"),
      badge: store.clipboard.rels.length > 1 ? t("kb.itemCount", { n: store.clipboard.rels.length }) : entryName(store.clipboard.rels[0]),
    });
  }
  // ④ 重命名 / 移动到… / 删除（SoloMD 的分组）
  items.push({ value: "rename", label: t("kb.actRename"), icon: "o.edit", group: t("kb.menuManage") });
  items.push({ value: "moveTo", label: t("kb.actMoveTo"), icon: "o.arrow-right", group: t("kb.menuManage") });
  items.push({ value: "delete", label: t("kb.actDelete"), icon: "o.trash", danger: true, group: t("kb.menuManage") });
  // Git：单文件提交历史（VS Code 有，SoloMD 的"复制 Git URL"是同源诉求）
  if (!isDir) {
    items.push({ value: "fileHistory", label: t("kb.fileHistory"), icon: "o.git-commit", group: "" });
  }
  // ⑤ 路径与位置（SoloMD：复制路径 / 复制相对路径 / 复制 Git URL → 我们到 ③ 的 remote 能力为止）
  items.push({ value: "copyPath", label: t("kb.actCopyPath"), icon: "o.copy", group: "" });
  items.push({ value: "copyRelPath", label: t("kb.actCopyRelPath"), icon: "o.copy", group: "" });
  items.push({ value: "reveal", label: t("kb.revealInFinder"), icon: "o.file-directory", group: "" });
  return items;
});

/** 原生目录选择器给出的是绝对路径；换算成根内相对路径（不在根内 → 返回 null）。 */
function toRelFromPicked(picked: string): string | null {
  const root = store.root ?? "";
  const normalizedRoot = root.replace(/\/$/, "");
  const normalizedPicked = picked.replace(/\/$/, "");
  if (normalizedPicked === normalizedRoot) return "";
  if (!normalizedPicked.startsWith(`${normalizedRoot}/`)) return null;
  return normalizedPicked.slice(normalizedRoot.length + 1);
}

function entryName(rel: string): string {
  return rel.split("/").pop() ?? rel;
}

async function onNodeMenuPick(value: string): Promise<void> {
  const entry = nodeMenu.value?.entry;
  const root = store.root;
  // **先取目标集再关菜单**：menuTargets 依赖 nodeMenu，反过来会把目标算成空集
  // （曾经把"删除/移动到…"变成静默无操作）
  const targets = [...menuTargets.value];
  nodeMenu.value = null;
  if (!entry || !root) return;
  const abs = `${root}/${entry.rel}`;
  try {
    switch (value) {
      case "open":
        store.select(entry.rel); // 打开 = 预览（选中即开页签）
        break;
      case "openExternal":
        await openPathWithConfiguredApp(root, entry.rel);
        break;
      case "newFile":
      case "newFolder": {
        // 目录 → 建在其内部；文件 → 建在其父目录（VS Code 语义）
        const parent = entry.kind === "dir" ? entry.rel : entry.rel.includes("/") ? entry.rel.slice(0, entry.rel.lastIndexOf("/")) : "";
        emit("create", { kind: value === "newFile" ? "file" : "dir", parent });
        break;
      }
      case "copy":
        store.setClipboard({ op: "copy", rels: targets });
        break;
      case "cut":
        store.setClipboard({ op: "cut", rels: targets });
        break;
      case "paste": {
        const parent = entry.kind === "dir" ? entry.rel : entry.rel.includes("/") ? entry.rel.slice(0, entry.rel.lastIndexOf("/")) : "";
        const pasted = await store.pasteInto(parent);
        pushToast({ kind: "success", message: t("kb.pasted", { name: entryName(pasted) }) }, 2500);
        break;
      }
      case "rename":
        renameTarget.value = entry.rel;
        break;
      case "moveTo": {
        const picked = await api.kbPickRoot();
        if (!picked) return;
        const rel = toRelFromPicked(picked);
        // 注意判 null 不判 falsy：rel 为空串 = 选中知识库根目录本身，那是合法落点
        if (rel === null) {
          pushToast({ kind: "error", message: t("kb.moveOutsideRoot") });
          return;
        }
        await moveEntries(targets, rel);
        break;
      }
      case "delete": {
        const ok = await confirmAction(
          targets.length > 1
            ? t("kb.deleteConfirmMany", { n: targets.length })
            : t("kb.deleteConfirm", { name: entryName(targets[0]) }),
          {
            title: t("kb.actDelete"),
            okLabel: t("kb.actDelete"),
            cancelLabel: t("common.cancel"),
          },
        );
        if (!ok) return;
        const failed: string[] = [];
        for (const rel of targets) {
          try {
            await store.deleteEntry(rel);
          } catch {
            failed.push(entryName(rel));
          }
        }
        const done = targets.length - failed.length;
        pushToast(
          failed.length
            ? { kind: "error", message: t("kb.deletePartial", { done, failed: failed.join("、") }) }
            : { kind: "success", message: t("kb.deletedMany", { n: done }) },
          4000,
        );
        break;
      }
      case "fileHistory":
        emit("fileHistory", entry.rel);
        break;
      case "copyPath":
        await copyText(abs);
        break;
      case "copyRelPath":
        await copyText(entry.rel);
        break;
      case "reveal":
        await revealPath(abs);
        break;
    }
  } catch (error) {
    pushToast({ kind: "error", message: t("kb.actionFailed", { reason: String(error) }) });
  }
}

/**
 * 批量移动（拖拽与「移动到…」共用）：逐项移动、统计失败、给出**撤销**。
 *
 * 撤销 = 反向再移一次（文件管理器都这么做）。这里不隐藏失败：部分失败会把名字列出来
 * —— 静默吞掉会让用户以为都成功了。
 */
async function moveEntries(rels: string[], destDir: string): Promise<void> {
  const root = store.root;
  if (!root || rels.length === 0) return;
  const moved: { from: string; to: string }[] = [];
  const failed: string[] = [];
  for (const rel of rels) {
    if (rel === destDir || parentOf(rel) === destDir || destDir.startsWith(`${rel}/`)) continue;
    const target = joinPath(destDir, baseName(rel));
    try {
      await api.kbMove(root, rel, target);
      moved.push({ from: rel, to: target });
    } catch {
      failed.push(baseName(rel));
    }
  }
  if (moved.length) {
    await store.refresh();
    store.setSelection(moved.map((item) => item.to));
  }
  if (!moved.length && failed.length) {
    pushToast({ kind: "error", message: t("kb.moveFailed", { names: failed.join("、") }) });
    return;
  }
  const destLabel = destDir ? baseName(destDir) : t("kb.rootLabel");
  pushToast(
    {
      kind: "success",
      message: failed.length
        ? t("kb.movePartial", { done: moved.length, dest: destLabel, failed: failed.join("、") })
        : t("kb.movedMany", { n: moved.length, dest: destLabel }),
      action: {
        label: t("kb.undo"),
        run: () => void undoMove(moved),
      },
    },
    8000,
  );
}

/** 撤销一次批量移动：把每一项移回原位。 */
async function undoMove(moved: { from: string; to: string }[]): Promise<void> {
  const root = store.root;
  if (!root) return;
  const back: { from: string; to: string }[] = [];
  for (const item of moved) {
    try {
      await api.kbMove(root, item.to, item.from);
      back.push({ from: item.to, to: item.from });
    } catch {
      /* 撤销失败就停在原地；下面统一提示 */
    }
  }
  await store.refresh();
  store.setSelection(back.map((item) => item.to));
  pushToast(
    back.length === moved.length
      ? { kind: "info", message: t("kb.undoDone") }
      : { kind: "error", message: t("kb.undoPartial", { n: moved.length - back.length }) },
    3000,
  );
}

// ---- 拖拽移动：手势事件驱动（HTML5 拖放在 Tauri 里会被原生处理吞掉）----
/** 按下但还没开始拖的候选（超过阈值才算真拖，避免和单击打架）。 */
let dragCandidate: { rel: string; x: number; y: number } | null = null;
const dragGhost = ref<HTMLElement | null>(null);
const dragging = computed(() => dragPaths.value.length > 0);
let hoverExpandTimer: number | null = null;
let autoScrollTimer: number | null = null;
let lastPointer: { x: number; y: number } | null = null;

function onPointerDown(payload: { rel: string; event: PointerEvent }): void {
  // 只认主键；修饰键按下时不拖（那是加选/范围选择的手势）
  if (payload.event.button !== 0) return;
  if (payload.event.metaKey || payload.event.ctrlKey || payload.event.shiftKey) return;
  // **必须掐掉默认行为**：浏览器从按下那一刻就开始原生"文字选择"，拖拽扫过的行
  // 会连成一片蓝色选区（事后再加 user-select: none 是来不及的，已发生的选择不会撤销）。
  payload.event.preventDefault();
  dragCandidate = { rel: payload.rel, x: payload.event.clientX, y: payload.event.clientY };
}

function hitTestRow(x: number, y: number): { rel: string; kind: "file" | "dir" } | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-rel]");
  if (!el) return null;
  const rel = el.dataset.rel ?? "";
  return { rel, kind: el.dataset.kind === "dir" ? "dir" : "file" };
}

/**
 * 拖到树的上下边缘时自动滚（文件管理器都有；没有它就只能拖到可见范围内，
 * 长列表里"拖到看不见的目录"根本做不到 —— 这是"不自然"的主要来源之一）。
 */
function stepAutoScroll(): void {
  // 真正滚动的是 .tree-body（外层 .tree 只是 flex 容器）
  const scroller = rootEl.value?.querySelector<HTMLElement>(".tree-body");
  const box = scroller?.getBoundingClientRect();
  if (!scroller || !box || !dragging.value || !lastPointer) return;
  const edge = 28;
  const speed = 12;
  const over = lastPointer.y - box.top;
  const below = box.bottom - lastPointer.y;
  let delta = 0;
  if (over < edge) delta = -speed;
  else if (below < edge) delta = speed;
  if (delta === 0) return;
  scroller.scrollTop += delta;
  // 滚动后指针下的行变了，重算落点
  const row = hitTestRow(lastPointer.x, lastPointer.y);
  const { dir, before } = resolveDropTarget(row);
  if (anyDroppable(dragPaths.value, dir)) {
    dropDir.value = dir;
    dropBefore.value = before;
    scheduleHoverExpand(row);
  }
}

function startAutoScroll(): void {
  if (autoScrollTimer !== null) return;
  autoScrollTimer = window.setInterval(stepAutoScroll, 60);
}

function stopAutoScroll(): void {
  if (autoScrollTimer !== null) {
    window.clearInterval(autoScrollTimer);
    autoScrollTimer = null;
  }
}

function onPointerMove(event: PointerEvent): void {
  if (dragCandidate && !dragging.value) {
    const far = Math.hypot(event.clientX - dragCandidate.x, event.clientY - dragCandidate.y);
    if (far < 4) return;
    // 开始拖：拖的是"选中的整批"（若拖动项在选中集里），否则就它自己
    const rel = dragCandidate.rel;
    dragPaths.value = store.selection.includes(rel) && store.selection.length > 1 ? [...store.selection] : [rel];
    renderGhost(event.clientX, event.clientY);
  }
  if (!dragging.value) return;
  lastPointer = { x: event.clientX, y: event.clientY };
  moveGhost(event.clientX, event.clientY);
  startAutoScroll();

  const row = hitTestRow(event.clientX, event.clientY);
  const { dir, before } = resolveDropTarget(row);
  if (anyDroppable(dragPaths.value, dir)) {
    dropDir.value = dir;
    dropBefore.value = before;
    scheduleHoverExpand(row);
  } else {
    // 落在非法位置：不给任何反馈（VS Code 同款 —— 没有可放的地方就不显示落点）
    dropDir.value = null;
    dropBefore.value = null;
  }
}

/** 悬停折叠目录 600ms 自动展开（VS Code 的行为）。 */
function scheduleHoverExpand(row: { rel: string; kind: "file" | "dir" } | null): void {
  if (hoverExpandTimer !== null) {
    window.clearTimeout(hoverExpandTimer);
    hoverExpandTimer = null;
  }
  if (!row || row.kind !== "dir" || store.expanded[row.rel]) return;
  hoverExpandTimer = window.setTimeout(() => {
    hoverExpandTimer = null;
    if (anyDroppable(dragPaths.value, row.rel)) void store.toggleDir(row.rel);
  }, 600);
}

async function onPointerUp(): Promise<void> {
  const candidate = dragCandidate;
  dragCandidate = null;
  stopAutoScroll();
  lastPointer = null;
  if (hoverExpandTimer !== null) {
    window.clearTimeout(hoverExpandTimer);
    hoverExpandTimer = null;
  }
  if (!dragging.value) return;
  const dest = dropDir.value;
  const paths = [...dragPaths.value];
  const wasDrag = true;
  endDrag();
  removeGhost();
  if (candidate && wasDrag) {
    // 吃掉紧随其后的那次 click：否则拖完会顺手把文件打开 / 目录折叠
    suppressClick.value = true;
    window.setTimeout(() => (suppressClick.value = false), 0);
  }
  if (dest === null) return;
  await moveEntries(paths, dest);
}

function renderGhost(x: number, y: number): void {
  // 拖动期间禁掉文本选择 + 换成抓取光标（否则拖过标签会选中文字，手感很毛躁）
  document.body.classList.add("tree-dragging");
  const el = document.createElement("div");
  el.className = "tree-drag-ghost";
  el.textContent =
    dragPaths.value.length > 1
      ? t("kb.dragMany", { n: dragPaths.value.length })
      : baseName(dragPaths.value[0] ?? "");
  document.body.appendChild(el);
  dragGhost.value = el;
  moveGhost(x, y);
}

function moveGhost(x: number, y: number): void {
  const el = dragGhost.value;
  if (!el) return;
  // 贴边时不越出视口（否则拖到右下角时提示会被切掉）
  const width = el.offsetWidth || 80;
  const height = el.offsetHeight || 20;
  el.style.left = `${Math.min(x + 10, window.innerWidth - width - 8)}px`;
  el.style.top = `${Math.min(y + 10, window.innerHeight - height - 8)}px`;
}

function removeGhost(): void {
  dragGhost.value?.remove();
  dragGhost.value = null;
  document.body.classList.remove("tree-dragging");
}

/** 首字母跳转（VS Code 的 type-ahead）：连续输入 600ms 内拼成一个前缀。 */
let typeahead = "";
let typeaheadAt = 0;

function onTreeKeydown(event: KeyboardEvent): void {
  // 只在树内响应（输入框里打字不该触发全选）
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;

  // 拖拽中按 Esc = 取消本次拖拽（不放）
  if (event.key === "Escape" && dragging.value) {
    stopAutoScroll();
    endDrag();
    removeGhost();
    return;
  }

  // ↑↓ 移动焦点（Shift 扩选）、←→ 收放/进出、Home/End 首末、Enter 打开、空格切换选中
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      store.moveFocus("down", event.shiftKey);
      scrollFocusIntoView();
      return;
    case "ArrowUp":
      event.preventDefault();
      store.moveFocus("up", event.shiftKey);
      scrollFocusIntoView();
      return;
    case "Home":
      event.preventDefault();
      store.moveFocus("first", event.shiftKey);
      scrollFocusIntoView();
      return;
    case "End":
      event.preventDefault();
      store.moveFocus("last", event.shiftKey);
      scrollFocusIntoView();
      return;
    case "ArrowRight":
      event.preventDefault();
      void store.focusExpand();
      scrollFocusIntoView();
      return;
    case "ArrowLeft":
      event.preventDefault();
      void store.focusCollapse();
      scrollFocusIntoView();
      return;
    case "Enter": {
      const rel = store.focusRel;
      if (!rel) return;
      event.preventDefault();
      const row = store.visibleRows().find((item) => item.rel === rel);
      if (row?.kind === "dir") void store.toggleDir(rel);
      else void store.openFile(rel);
      return;
    }
    case " ":
      if (!store.focusRel) return;
      event.preventDefault();
      store.toggleSelection(store.focusRel);
      return;
    case "Escape":
      store.clearSelection();
      return;
    default:
      break;
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    store.selectAllVisible();
    return;
  }
  // type-ahead：打印字符时跳到下一个以该前缀开头的可见行
  if (event.metaKey || event.ctrlKey || event.altKey || event.key.length !== 1) return;
  const now = Date.now();
  typeahead = now - typeaheadAt > 600 ? event.key : typeahead + event.key;
  typeaheadAt = now;
  const rows = store.visibleRows();
  const index = rows.findIndex((row) => row.rel === store.focusRel);
  const ordered = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
  const hit = ordered.find((row) => (row.rel.split("/").pop() ?? "").toLowerCase().startsWith(typeahead.toLowerCase()));
  if (hit) {
    store.selectOnly(hit.rel);
    scrollFocusIntoView();
  }
}

/** 把键盘焦点交给树容器（点任意一行后按 ↑↓ 才有作用对象）。 */
function focusTreeBody(): void {
  rootEl.value?.querySelector<HTMLElement>(".tree-body")?.focus();
}

/** 键盘移动焦点后把它滚进视野（宿主没有该 API 时静默跳过）。 */
function scrollFocusIntoView(): void {
  void nextTick(() => {
    const rel = store.focusRel;
    if (!rel) return;
    rootEl.value
      ?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(rel)}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  });
}

onMounted(() => {
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
  // 键盘**只挂在树容器上**（`.tree-body` 有 tabindex）：挂 window 会与容器上的
  // 处理重复触发 —— 按一下 ↓ 走两格（测试当场抓到）。在树内才响应也是对的：
  // 否则在搜索框/编辑器里打字会去驱动文件树。
});
onBeforeUnmount(() => {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", onPointerUp);
  removeGhost();
});

/** 复制到剪贴板：Tauri 用 Clipboard API（webview 支持），失败时静默（不打断操作流）。 */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    pushToast({ kind: "success", message: t("kb.pathCopied") }, 2000);
  } catch {
    // 剪贴板不可用（权限/非安全上下文）—— 静默失败比弹错更不打扰
  }
}

/** 「在文件树中显示」：展开全部祖先，滚到该行并短暂高亮。 */
async function revealRel(rel: string): Promise<void> {
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const dir = parts.slice(0, i).join("/");
    if (!store.expanded[dir]) await store.toggleDir(dir);
  }
  store.select(rel);
  await nextTick();
  const row = rootEl.value?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(rel)}"]`);
  row?.scrollIntoView?.({ block: "nearest" });
  row?.classList.add("flash");
  setTimeout(() => row?.classList.remove("flash"), 900);
}

defineExpose({ revealRel });

const filterOpen = ref(false);
const filterInput = ref<HTMLInputElement | null>(null);
const draft = ref("");

const menuItems = computed<ActionItem[]>(() => [
  {
    value: "showIgnored",
    label: t("kb.showIgnored"),
    icon: store.showIgnored ? "o.check" : undefined,
    group: t("kb.menuView"),
  },
  { value: "filter", label: t("kb.filter"), icon: "o.search", group: t("kb.menuView") },
]);

function onMenuPick(value: string): void {
  if (value === "showIgnored") void store.setShowIgnored(!store.showIgnored);
  if (value === "filter") openFilter();
}

function openFilter(): void {
  filterOpen.value = true;
  draft.value = store.filter;
  void nextTick(() => filterInput.value?.focus());
}

function closeFilter(): void {
  filterOpen.value = false;
  draft.value = "";
  store.setFilter("");
}

const filtering = computed(() => !!store.filter);
</script>

<template>
  <aside ref="rootEl" class="tree">
    <header class="tree-header">
      <!-- 纯标识：切换入口在 App header -->
      <div class="root-label" :title="store.root ?? t('kb.noRoot')">
        <EditorIcon name="o.book" />
        <span class="root-name">{{ store.rootName || t("kb.pickRoot") }}</span>
      </div>
      <div class="header-actions">
        <button class="icon-btn" :title="t('kb.newFile')" @click="emit('create', { kind: 'file' })">
          <EditorIcon name="c.new-file" />
        </button>
        <button class="icon-btn" :title="t('kb.newFolder')" @click="emit('create', { kind: 'dir' })">
          <EditorIcon name="c.new-folder" />
        </button>
        <button class="icon-btn" :title="t('common.refresh')" @click="store.refresh()">
          <EditorIcon name="c.refresh" />
        </button>
        <button class="icon-btn" :title="t('kb.collapseAll')" @click="store.collapseAll()">
          <EditorIcon name="c.collapse-all" />
        </button>
        <ActionMenu
          :items="menuItems"
          trigger-icon="ellipsis"
          size="ui"
          :title="t('kb.menuView')"
          @pick="onMenuPick"
        />
      </div>
    </header>

    <div v-if="filterOpen" class="filter-row">
      <EditorIcon name="o.search" class="filter-leading" />
      <input
        ref="filterInput"
        v-model="draft"
        class="filter-input"
        :placeholder="t('kb.filterPlaceholder')"
        @input="store.setFilter(draft)"
        @keydown.escape="closeFilter"
      />
      <button class="filter-clear" :title="t('kb.filterClear')" @click="closeFilter">
        <EditorIcon name="o.x" />
      </button>
    </div>
    <p v-if="filtering" class="filter-note">{{ t("kb.filterScope") }}</p>
    <p v-if="store.selection.length > 1" class="selection-note">
      {{ t("kb.selectedCount", { n: store.selection.length }) }}
    </p>

    <div
      class="tree-body"
      :class="{ 'drop-root': dragging && dropDir === '' }"
      role="tree"
      tabindex="0"
      data-rel=""
      data-kind="dir"
      @keydown="onTreeKeydown"
    >
      <p v-if="store.rootMissing" class="tree-note warn">{{ t("kb.rootMissing") }}</p>
      <p v-else-if="!store.root" class="tree-note">{{ t("kb.noRoot") }}</p>
      <p v-else-if="store.error" class="tree-note warn">{{ store.error }}</p>
      <p v-else-if="store.filterEmpty" class="tree-note">{{ t("kb.filterEmpty") }}</p>
      <p v-else-if="!filtering && (store.children[''] ?? []).length === 0" class="tree-note">
        {{ t("kb.emptyDir") }}
      </p>
      <KnowledgeTreeNode
        v-for="entry in store.visibleChildren('')"
        :key="entry.rel"
        :entry="entry"
        :depth="0"
        @menu="nodeMenu = $event"
        @drag-start="onPointerDown"
        @focus-tree="focusTreeBody"
      />
    </div>

    <ActionMenu
      v-if="nodeMenu"
      :items="nodeMenuItems"
      :anchor="{ x: nodeMenu.x, y: nodeMenu.y }"
      size="ui"
      @pick="onNodeMenuPick"
      @close="nodeMenu = null"
    />

    <KnowledgeRenameDialog
      v-if="renameTarget"
      :rel="renameTarget"
      @close="renameTarget = null"
      @renamed="(name) => pushToast({ kind: 'success', message: t('kb.renamed', { name }) }, 2500)"
    />
  </aside>
</template>

<style scoped>
.tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg-panel);
  outline: none !important;
}
.tree-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  height: 34px;
  /* 左右统一 8px：与行首基准对齐（原先左 12 / 右 8 不对称） */
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
/* 根标识（非按钮：无悬停态、无指针） */
.root-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: var(--text);
  /* 组头名称档（规范：组头名称 = base/600） */
  font-size: var(--font-base);
  font-weight: 600;
}
.root-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
/* 过滤条（VS Code 的 Explorer 过滤同形态：一行输入 + 前置放大镜 + 清除） */
.filter-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.filter-leading {
  flex: none;
  color: var(--text-dim);
}
.filter-input {
  flex: 1;
  min-width: 0;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  outline: none;
}
.filter-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.filter-clear:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.filter-note {
  margin: 6px 12px 0;
  /* 次级元信息档（规范：说明文字 = sm），不用 xs（那是徽标/角标档） */
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.tree-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  user-select: none;
  /* tabindex="0"（键盘导航用）会让容器获得焦点，浏览器画默认焦点环 ——
     表现为"整棵树外面一圈高亮"（用户实测截图，两次修不好是因为 WKWebView
     不止用 outline 一条路画焦点：还可能走 box-shadow / border / -webkit-focus-ring）。
     一套全部压掉；键盘焦点的视觉指示已由 .row.focused 的行内焦点环承担。 */
  outline: none !important;
  -webkit-appearance: none;
  box-shadow: none !important;
  border-color: transparent !important;
  /* 列表与表头之间留 4px 呼吸（用户口径），底部保留 8px 便于滚过末行 */
  padding: 4px 0 8px;
}
.tree-note {
  margin: 10px 14px;
  font-size: var(--font-sm);
  color: var(--text-dim);
  line-height: 1.5;
}
.tree-note.warn {
  color: var(--warning);
}
/* 「在文件树中显示」的短暂高亮 */
.tree :deep(.row.flash) {
  background: var(--bg-selected);
}
.tree-body.drop-root {
  box-shadow: inset 0 0 0 1px var(--accent);
}
.selection-note {
  margin: 0;
  padding: 2px 10px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
</style>
