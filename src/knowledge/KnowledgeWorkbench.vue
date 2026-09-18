<script setup lang="ts">
/**
 * 知识库工作台 —— **单面板**（`listPanel === detailPanel`，与「项目」同款）。
 *
 * 工作台布局层（stores/workbench.ts）对单面板工作区只生成一个叶子：
 * 面板不会被类型切换器换掉、不会被拆开、不会被关掉。树与预览/编辑器的
 * 分栏在**面板内部**用既有的 SplitPane 原语完成（VS Code 侧栏 ≈280px 起步，
 * 拖拽下限由 SplitPane 的 min 比例兜住）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import PanelShell from "../workbench/PanelShell.vue";
import SplitPane from "../workbench/SplitPane.vue";
import { api, isTauri } from "../api";
import { useI18n } from "../i18n";
import { useKnowledgeStore } from "../stores/knowledge";
import KnowledgePreview from "./KnowledgePreview.vue";
import KnowledgeTabs from "./KnowledgeTabs.vue";
import KnowledgeTree from "./KnowledgeTree.vue";
import KnowledgeQuickOpen from "./KnowledgeQuickOpen.vue";
import KnowledgeSearchPalette from "./KnowledgeSearchPalette.vue";
import KnowledgeCreateDialog from "./KnowledgeCreateDialog.vue";
import KnowledgeFileHistoryDrawer from "./KnowledgeFileHistoryDrawer.vue";

defineProps<{ leafId?: string; panelType?: string }>();

const store = useKnowledgeStore();
const { t } = useI18n();

/**
 * 两个浮层：⌘P 快速打开、⌘⇧F 全文搜索。
 * 搜索不做成左栏常驻视图（用户口径）：它是只读跳转，与 ⌘P 同类交互，
 * 浮层形态让左栏保持"只有文件树"一件事。
 */
const quickOpen = ref(false);
const searchOpen = ref(false);

/**
 * 命令入口统一由**菜单/全局快捷键**下发（App.vue → store.pendingCommand）：
 * 这样 ⌘P 在任何工作区都能用，面板只负责执行，不再自己监听键盘（否则两处都响应）。
 */
watch(
  () => store.pendingCommand,
  (command) => {
    if (!command) return;
    store.clearCommand();
    if (command === "quickOpen") quickOpen.value = true;
    else searchOpen.value = true;
  },
  { immediate: true },
);

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

// ---- 外部改动 watcher（T10）：Rust 侧 2s 轮询 mtime，变更时发 kb://changed ----
let unlisten: (() => void) | null = null;
let reloadTimer: number | null = null;

watch(
  () => store.root,
  (root) => {
    // 换根 = 重启 watcher（Rust 侧按代际替换旧线程）；清根 = 停止
    if (isTauri() && root) void api.kbWatchStart(root).catch(() => {});
    else if (isTauri()) void api.kbWatchStop().catch(() => {});
  },
  { immediate: true },
);

void (async () => {
  if (!isTauri()) return;
  const { listen } = await import("@tauri-apps/api/event");
  unlisten = await listen<string>("kb://changed", (event) => {
    if (event.payload === "root-missing") {
      // 根被移动/删除：触发一次刷新，store 的守卫会显示"文件夹不存在"空态
      void store.refresh();
      return;
    }
    // 去抖：外部改动常是连续写入，0.8s 内只刷一次（树 + 预览）
    if (reloadTimer !== null) window.clearTimeout(reloadTimer);
    reloadTimer = window.setTimeout(() => {
      reloadTimer = null;
      reloadTick.value += 1;
      void store.refresh();
    }, 800);
  });
})();

onBeforeUnmount(() => {
  unlisten?.();
  if (reloadTimer !== null) window.clearTimeout(reloadTimer);
  if (isTauri()) void api.kbWatchStop().catch(() => {});
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
        <KnowledgeTree ref="treeRef" @create="createRequest = $event" @file-history="historyRel = $event" />
      </template>
      <template #second>
        <div v-if="emptyRoot" class="kb-welcome">
          <p class="kb-welcome-title">{{ t("kb.welcomeTitle") }}</p>
          <p class="kb-welcome-note">{{ t("kb.welcomeNote") }}</p>
          <button class="text-btn primary" @click="store.openSwitch()">{{ t("kb.pickRoot") }}</button>
        </div>
        <KnowledgePreview v-else ref="previewRef" :reload-tick="reloadTick" @reveal-in-tree="revealInTree" />
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
    <KnowledgeSearchPalette v-if="searchOpen" @close="searchOpen = false" />
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
</style>
