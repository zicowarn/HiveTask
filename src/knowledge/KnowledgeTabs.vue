<script setup lang="ts">
/**
 * 打开的文件页签（面板头左侧，PanelShell 的 `#switcher` 槽）。
 *
 * 形态参考「项目」面板的视图页签 + VS Code 的编辑器页签条：
 * - 页签条自成一条**带底色的横带**（与面板内容区分），页签之间 1px 分隔线；
 * - **激活页签**：面板底色 + 三面 1px 描边 + 顶部 2px 强调线 + 字重 600 + 压住头部分隔线
 *   （一眼能看出"正在编辑哪个文件"）；
 * - 页签溢出时，左右两端出现**方向按钮**（只在对应方向还有内容时显示）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ActionMenu, { type ActionItem } from "../components/ActionMenu.vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useI18n } from "../i18n";
import { useKnowledgeStore } from "../stores/knowledge";
import { pushToast } from "../toast";
import { openPathWithConfiguredApp, revealPath, writeClipboard } from "./open-path";

const store = useKnowledgeStore();
const { t } = useI18n();

const strip = ref<HTMLElement | null>(null);
const overflowing = ref(false);
const atStart = ref(true);
const atEnd = ref(true);

function syncArrows(): void {
  const el = strip.value;
  if (!el) return;
  overflowing.value = el.scrollWidth - el.clientWidth > 1;
  atStart.value = el.scrollLeft <= 1;
  atEnd.value = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
}

function scrollBy(direction: -1 | 1): void {
  const el = strip.value;
  if (!el) return;
  el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.6), behavior: "smooth" });
}

/** 激活页签滚动到可见（切文件时页签可能在被卷走的位置）。 */
function scrollActiveIntoView(): void {
  const el = strip.value?.querySelector<HTMLElement>(".tab.active");
  el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  syncArrows();
}

watch(
  () => [store.tabs.length, store.selected],
  () => void nextTick(() => {
    syncArrows();
    scrollActiveIntoView();
  }),
);

onMounted(() => {
  syncArrows();
  strip.value?.addEventListener("scroll", syncArrows, { passive: true });
  window.addEventListener("resize", syncArrows);
});
onBeforeUnmount(() => {
  strip.value?.removeEventListener("scroll", syncArrows);
  window.removeEventListener("resize", syncArrows);
});

function nameOf(rel: string): string {
  return rel.split("/").pop() ?? rel;
}

// ---- 页签右键菜单（对齐 VS Code 的编辑器页签菜单，参照见计划 §10 与交付说明）----
const tabMenu = ref<{ rel: string; x: number; y: number } | null>(null);
const emit = defineEmits<{
  /** 切换编辑模式（"重新打开方式"的映射：实时渲染 / 源码模式）。 */
  viewMode: [value: "rich" | "source"];
  /** 在文件树中显示（选中 + 展开祖先 + 滚动到可见）——由工作台处理。 */
  revealInTree: [rel: string];
  /** 查看单文件提交历史（由工作台打开抽屉）。 */
  fileHistory: [rel: string];
}>();

const tabMenuItems = computed<ActionItem[]>(() => {
  const rel = tabMenu.value?.rel;
  if (!rel) return [];
  const pinned = store.pinned.includes(rel);
  const items: ActionItem[] = [
    { value: "close", label: t("kb.tabClose"), icon: "o.x", badge: "⌘W" },
    { value: "closeOthers", label: t("kb.tabCloseOthers"), icon: "o.x" },
    { value: "closeRight", label: t("kb.tabCloseRight"), icon: "o.x" },
    { value: "closeSaved", label: t("kb.tabCloseSaved"), icon: "o.x" },
    { value: "closeAll", label: t("kb.tabCloseAll"), icon: "o.x" },
    // 复制类（与树菜单同源能力）
    { value: "copyPath", label: t("kb.actCopyPath"), icon: "o.copy", group: "" },
    { value: "copyRelPath", label: t("kb.actCopyRelPath"), icon: "o.copy", group: "" },
    // 重新打开方式：映射为我们的两种编辑模式 + 默认应用（③适配）
    { value: "reopenRich", label: t("kb.reopenRich"), icon: "o.markdown", group: "" },
    { value: "reopenSource", label: t("kb.reopenSource"), icon: "o.md-code", group: "" },
    { value: "reopenExternal", label: t("kb.openWithDefault"), icon: "o.link-external", group: "" },
    // Git：单文件提交历史（Rust 侧按 pathspec 过滤；非 git 仓库会在抽屉里如实提示）
    { value: "fileHistory", label: t("kb.fileHistory"), icon: "o.git-commit", group: "", badge: "⌥H" },
    // 位置
    { value: "reveal", label: t("kb.revealInFinder"), icon: "o.file-directory", group: "", badge: "⌥⌘R" },
    { value: "revealInTree", label: t("kb.revealInTree"), icon: "o.list-ordered", group: "" },
    // 固定
    { value: "pin", label: pinned ? t("kb.tabUnpin") : t("kb.tabPin"), icon: "o.pin", group: "" },
  ];
  return items;
});

async function onTabMenuPick(value: string): Promise<void> {
  const rel = tabMenu.value?.rel;
  const root = store.root;
  tabMenu.value = null;
  if (!rel) return;
  const abs = root ? `${root}/${rel}` : "";
  switch (value) {
    case "close":
      store.closeTab(rel);
      break;
    case "closeOthers":
      store.closeOthers(rel);
      break;
    case "closeRight":
      store.closeToRight(rel);
      break;
    case "closeSaved": {
      const closed = store.closeSaved();
      pushToast({ kind: "info", message: t("kb.tabClosedSaved", { n: closed }) }, 2500);
      break;
    }
    case "closeAll":
      store.closeAll();
      break;
    case "copyPath":
      await copyText(abs);
      break;
    case "copyRelPath":
      await copyText(rel);
      break;
    case "reopenRich":
      emit("viewMode", "rich");
      break;
    case "reopenSource":
      emit("viewMode", "source");
      break;
    case "reopenExternal":
      if (root) await openPathWithConfiguredApp(root, rel);
      break;
    case "fileHistory":
      emit("fileHistory", rel);
      break;
    case "reveal":
      if (abs) {
        try {
          await revealPath(abs);
        } catch (error) {
          pushToast({ kind: "error", message: t("kb.actionFailed", { reason: String(error) }) });
        }
      }
      break;
    case "revealInTree":
      store.select(rel); // 先确保它是当前项
      emit("revealInTree", rel);
      break;
    case "pin":
      store.togglePin(rel);
      break;
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await writeClipboard(text);
    pushToast({ kind: "success", message: t("kb.pathCopied") }, 2000);
  } catch {
    // 剪贴板不可用 → 静默（与树菜单一致）
  }
}

function openTabMenu(rel: string, event: MouseEvent): void {
  tabMenu.value = { rel, x: event.clientX, y: event.clientY };
}

function iconOf(rel: string): string {
  const ext = rel.includes(".") ? rel.split(".").pop()!.toLowerCase() : "";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "o.markdown";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"].includes(ext)) return "o.file-media";
  return "o.file";
}
</script>

<template>
  <div v-if="store.tabs.length > 0" class="tabs-wrap">
    <button
      v-if="overflowing && !atStart"
      class="scroll-btn"
      :title="t('kb.scrollLeft')"
      @click="scrollBy(-1)"
    >
      <EditorIcon name="o.chevron-left" />
    </button>

    <div ref="strip" class="tabs" role="tablist">
      <div
        v-for="rel in store.tabs"
        :key="rel"
        class="tab"
        :class="{ active: rel === store.selected, pinned: store.pinned.includes(rel), dirty: store.isDirty(rel) }"
        role="tab"
        :aria-selected="rel === store.selected"
        :title="rel"
        @contextmenu.prevent.stop="openTabMenu(rel, $event)"
      >
        <button class="tab-main" @click="store.select(rel)">
          <EditorIcon :name="iconOf(rel)" />
          <span class="tab-name">{{ nameOf(rel) }}</span>
          <EditorIcon v-if="store.pinned.includes(rel)" name="o.pin" class="tab-pin" />
          <span v-if="store.isDirty(rel)" class="tab-dot" :title="t('kb.unsavedTip')">●</span>
        </button>
        <button class="tab-close" :title="t('common.close')" @click.stop="store.closeTab(rel)">
          <EditorIcon name="o.x" />
        </button>
      </div>
    </div>

    <button
      v-if="overflowing && !atEnd"
      class="scroll-btn"
      :title="t('kb.scrollRight')"
      @click="scrollBy(1)"
    >
      <EditorIcon name="o.chevron-right" />
    </button>

    <ActionMenu
      v-if="tabMenu"
      :items="tabMenuItems"
      :anchor="{ x: tabMenu.x, y: tabMenu.y }"
      size="ui"
      @pick="onTabMenuPick"
      @close="tabMenu = null"
    />
  </div>
</template>

<style scoped>
.tabs-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 与左侧 Editor 切换器留出明确间隙（父级 gap 8px + 这里 6px = 共 14px）：
     方向按钮的描边不得贴着切换器的边框 */
  margin-left: 6px;
  min-width: 0;
  height: 24px;
}
.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  height: 24px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.tabs::-webkit-scrollbar {
  height: 0;
}
/* 简洁风（对齐「项目」的视图页签）：圆角小片，无描边、无强调条 */
.tab {
  display: inline-flex;
  align-items: center;
  flex: none;
  max-width: 190px;
  height: 24px;
  border-radius: 6px;
  color: var(--text-dim);
}
.tab:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.tab.active {
  background: var(--bg-chip);
  color: var(--text);
}
.tab-main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0 4px 0 9px;
  border: none;
  background: transparent;
  color: inherit;
  /* 页签与「项目」视图页签同档（base 13px） */
  font-size: var(--font-base);
  cursor: pointer;
}
/* 选中态只靠底色 + 加粗（用户：顶部高亮多余） */
.tab.active .tab-main {
  font-weight: 600;
}
/* 固定页签：图钉（Octicon o.pin）；未保存：小圆点 */
.tab-pin {
  flex: none;
  color: var(--text-dim);
  transform: rotate(45deg);
}
.tab.dirty .tab-dot {
  flex: none;
  font-size: var(--font-xs);
  color: var(--accent);
}
.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-right: 5px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  opacity: 0;
}
.tab:hover .tab-close,
.tab.active .tab-close {
  opacity: 1;
}
.tab-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.scroll-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text-dim);
  cursor: pointer;
}
.scroll-btn:hover {
  color: var(--text);
  border-color: var(--accent);
}
</style>
