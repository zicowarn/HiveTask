<script setup lang="ts">
/**
 * 知识库工作台 —— **单面板**（`listPanel === detailPanel`，与「项目」同款）。
 *
 * 工作台布局层（stores/workbench.ts）对单面板工作区只生成一个叶子：
 * 面板不会被类型切换器换掉、不会被拆开、不会被关掉。树与预览/编辑器的
 * 分栏在**面板内部**用既有的 SplitPane 原语完成（VS Code 侧栏 ≈280px 起步，
 * 拖拽下限由 SplitPane 的 min 比例兜住）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import PanelShell from "../workbench/PanelShell.vue";
import SplitPane from "../workbench/SplitPane.vue";
import { isTauri } from "../api";
import { useI18n } from "../i18n";
import { useKnowledgeStore } from "../stores/knowledge";
import KnowledgePreview from "./KnowledgePreview.vue";
import KnowledgeTabs from "./KnowledgeTabs.vue";
import KnowledgeTree from "./KnowledgeTree.vue";
import KnowledgeSearchView from "./KnowledgeSearchView.vue";
import KnowledgeQuickOpen from "./KnowledgeQuickOpen.vue";
import KnowledgeCreateDialog from "./KnowledgeCreateDialog.vue";
import KnowledgeFileHistoryDrawer from "./KnowledgeFileHistoryDrawer.vue";

defineProps<{ leafId?: string; panelType?: string }>();

const store = useKnowledgeStore();
const { t } = useI18n();

/** 左栏两个视图：文件树 / 全文搜索（MarkText 的 sidebar 同构）。 */
const sideView = ref<"files" | "search">("files");
const searchRef = ref<{ focusInput: () => void } | null>(null);
const quickOpen = ref(false);

function switchToSearch(): void {
  sideView.value = "search";
  void nextTick(() => searchRef.value?.focusInput());
}

/** ⌘P 快速打开、⌘⇧F 搜索（VS Code 同款；⌘F 留给预览内的查找）。 */
function onShortcut(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (key === "p" && !event.shiftKey) {
    event.preventDefault();
    quickOpen.value = true;
    return;
  }
  if (key === "f" && event.shiftKey) {
    event.preventDefault();
    switchToSearch();
  }
}

onMounted(() => window.addEventListener("keydown", onShortcut));
onBeforeUnmount(() => window.removeEventListener("keydown", onShortcut));

const WIDTH_KEY = "hivetask.kb.treeRatio";
const ratio = ref(loadRatio());

function loadRatio(): number {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw > 0.1 && raw < 0.7) return raw;
  } catch {
    // 存储不可用 → 用默认
  }
  // VS Code 侧栏默认约 300px；1280 窗口下 ≈ 0.23
  return 0.23;
}

watch(ratio, (value) => {
  try {
    localStorage.setItem(WIDTH_KEY, String(value));
  } catch {
    // 存储不可用 → 本次会话内仍然生效
  }
});

onMounted(() => {
  void store.probeRoot();
});

const emptyRoot = computed(() => isTauri() && !store.root);

/** 面板级刷新：重读整棵树（含已展开分支）并让预览重读当前文件。 */
const reloadTick = ref(0);
async function reloadAll(): Promise<void> {
  await store.refresh();
  reloadTick.value += 1;
}

const previewRef = ref<{ setViewMode: (value: "rich" | "source") => void } | null>(null);
/** 单文件提交历史抽屉的目标（null = 关闭）。 */
const historyRel = ref<string | null>(null);
const treeRef = ref<{ revealRel: (rel: string) => void } | null>(null);

/** 「重新打开方式」：实时渲染 / 源码模式（映射自 VS Code 的 Reopen Editor With…）。 */
function onViewMode(value: "rich" | "source"): void {
  previewRef.value?.setViewMode(value);
}

/** 「在文件树中显示」：展开祖先并滚动到该行。 */
function revealInTree(rel: string): void {
  treeRef.value?.revealRel(rel);
}

/** 「新建文件 / 新建文件夹」对话框状态（null = 关闭）；parent 为显式落点。 */
const createRequest = ref<{ kind: "file" | "dir"; parent?: string } | null>(null);
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template #switcher>
      <KnowledgeTabs
        @view-mode="onViewMode"
        @reveal-in-tree="revealInTree"
        @file-history="historyRel = $event"
      />
    </template>
    <template #actions>
      <button class="text-btn" :title="t('kb.refreshAll')" @click="reloadAll">
        {{ t("common.refresh") }}
      </button>
    </template>

    <SplitPane direction="horizontal" :initial-ratio="ratio" :min="0.12" @update:ratio="ratio = $event">
      <template #first>
        <div class="kb-side">
          <div class="kb-side-tabs">
            <button class="side-tab" :class="{ on: sideView === 'files' }" @click="sideView = 'files'">
              {{ t("kb.tabFiles") }}
            </button>
            <button class="side-tab" :class="{ on: sideView === 'search' }" @click="switchToSearch">
              {{ t("kb.tabSearch") }}
            </button>
          </div>
          <div class="kb-side-body">
            <KnowledgeTree
              v-show="sideView === 'files'"
              ref="treeRef"
              @create="createRequest = $event"
              @file-history="historyRel = $event"
            />
            <KnowledgeSearchView v-if="sideView === 'search'" ref="searchRef" />
          </div>
        </div>
      </template>
      <template #second>
        <div v-if="emptyRoot" class="kb-welcome">
          <p class="kb-welcome-title">{{ t("kb.welcomeTitle") }}</p>
          <p class="kb-welcome-note">{{ t("kb.welcomeNote") }}</p>
          <button class="text-btn primary" @click="store.openSwitch()">{{ t("kb.pickRoot") }}</button>
        </div>
        <KnowledgePreview v-else ref="previewRef" :reload-tick="reloadTick" />
      </template>
    </SplitPane>

    <KnowledgeFileHistoryDrawer
      v-if="historyRel && store.root"
      :open="true"
      :root="store.root"
      :rel="historyRel"
      @close="historyRel = null"
    />

    <KnowledgeCreateDialog
      v-if="createRequest"
      :kind="createRequest.kind"
      :parent="createRequest.parent"
      @close="createRequest = null"
    />
    <KnowledgeQuickOpen v-if="quickOpen" @close="quickOpen = false" />
  </PanelShell>
</template>

<style scoped>
.text-btn {
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  white-space: nowrap;
  flex: none;
  cursor: pointer;
}
.text-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.text-btn.primary {
  background: var(--btn-primary);
  border-color: var(--btn-primary-border);
  color: #fff;
  height: 26px;
}
.text-btn.primary:hover {
  background: var(--btn-primary-hover);
  color: #fff;
}
.kb-welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  height: 100%;
  padding-top: 72px;
  background: var(--bg-panel);
}
.kb-welcome-title {
  margin: 0;
  font-size: var(--font-xl);
  font-weight: 600;
  color: var(--text);
}
.kb-welcome-note {
  margin: 0 0 6px;
  max-width: 420px;
  font-size: var(--font-sm);
  line-height: 1.7;
  color: var(--text-dim);
  text-align: center;
}
.kb-side {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-panel);
}
.kb-side-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  padding: 4px 8px 0;
  border-bottom: 1px solid var(--border);
}
.side-tab {
  height: 22px;
  padding: 0 10px;
  border: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  cursor: pointer;
}
.side-tab.on {
  background: var(--bg-chip, var(--bg-hover));
  color: var(--text);
  font-weight: 600;
}
.kb-side-body {
  flex: 1 1 auto;
  min-height: 0;
}
</style>
