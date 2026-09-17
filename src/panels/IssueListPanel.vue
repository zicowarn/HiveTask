<script setup lang="ts">
/**
 * Issue list panel — registered as "issue.list" (see workbench/registry.ts).
 * Hosts the panel chrome and the mode switch (flat list / milestone groups);
 * the open/closed/all tabs are a store-level filter shared by both modes.
 */
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import ModeTabs from "../components/ModeTabs.vue";
import IssueCreateDialog from "./IssueCreateDialog.vue";
import MilestoneCreateDialog from "./MilestoneCreateDialog.vue";
import { resolvePanel } from "../workbench/registry";
import { useIssuesStore } from "../stores/issues";
import { useRepoStore } from "../stores/repo";
import { useI18n } from "../i18n";
import { stateLabel } from "./state-label";
import type { IssueState } from "../types";

defineProps<{ leafId?: string; panelType?: string }>();

const PANEL_TYPE = "issue.list";
const MODE_STORAGE_KEY = "hivetask.panel-mode.issue.list";

const def = resolvePanel(PANEL_TYPE);
const modes = def.modes ?? [];

const store = useIssuesStore();
const repoStore = useRepoStore();
const { t } = useI18n();
const { state, loading, error } = storeToRefs(store);

// 标签目录随仓库加载（Issue 列表/详情 chip 着色 + 创建对话框选择器共享）
watch(
  () => repoStore.current,
  (repo) => {
    if (repo) void store.loadLabels(repo);
  },
  { immediate: true },
);

const storedMode =
  modes.find((m) => m.key === localStorage.getItem(MODE_STORAGE_KEY))?.key ?? modes[0]?.key;
const modeKey = ref(storedMode);
watch(modeKey, (key) => {
  localStorage.setItem(MODE_STORAGE_KEY, key);
  // 里程碑选中主体只存在于里程碑模式上下文，切走即清除（右栏回落 issue 详情）
  if (key !== "milestone") store.selectMilestone(null);
});

const activeMode = computed(() => modes.find((m) => m.key === modeKey.value) ?? modes[0]);
const modeComp = ref<{ collapseAll: () => void; expandAll: () => void; refresh: () => void } | null>(null);
const msTab = ref<"open" | "closed" | "all">("open");
const isMilestoneMode = computed(() => activeMode.value?.key === "milestone");

const states: { value: IssueState }[] = [
  { value: "open" },
  { value: "closed" },
  { value: "all" },
];

// 新建入口统一为对话框（与 PR 创建同构）：mode 感知的两个开关互斥。
const issueCreateOpen = ref(false);
const milestoneCreateOpen = ref(false);
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template v-if="modes.length > 1" #switcher>
      <ModeTabs v-model="modeKey" :modes="modes" />
    </template>
    <div class="list-toolbar">
      <div v-if="!isMilestoneMode" class="state-tabs">
        <button
          v-for="s in states"
          :key="s.value"
          class="state-tab"
          :class="{ active: state === s.value }"
          @click="store.setState(s.value)"
        >
          {{ stateLabel(s.value) }}
        </button>
      </div>
      <div v-else class="state-tabs">
        <button
          v-for="m in (['open', 'closed', 'all'] as const)"
          :key="m"
          class="state-tab"
          :class="{ active: msTab === m }"
          @click="msTab = m"
        >
          {{ stateLabel(m) }}
        </button>
      </div>
      <span class="toolbar-spacer"></span>
      <button
        v-if="isMilestoneMode"
        class="refresh-btn"
        @click="modeComp?.collapseAll()"
      >{{ t("milestone.collapseAll") }}</button>
      <button
        v-if="isMilestoneMode"
        class="refresh-btn"
        @click="modeComp?.expandAll()"
      >{{ t("milestone.expandAll") }}</button>
      <button
        class="refresh-btn"
        :disabled="loading"
        :title="isMilestoneMode ? t('milestone.refreshHint') : t('issue.refreshHint')"
        @click="isMilestoneMode ? modeComp?.refresh() : store.refresh()"
      >
        {{ loading ? t("common.syncing") : t("common.refresh") }}
      </button>
      <button class="refresh-btn create-btn" @click="((issueCreateOpen = true), (milestoneCreateOpen = false))">
        {{ t("issue.createBtn") }}
      </button>
      <button
        v-if="isMilestoneMode"
        class="refresh-btn create-btn"
        @click="((milestoneCreateOpen = true), (issueCreateOpen = false))"
      >
        {{ t("milestone.createBtn") }}
      </button>
    </div>

    <p v-if="error" class="error-banner">{{ error }}</p>

    <component :is="activeMode.component" ref="modeComp" :tab="msTab" />

    <IssueCreateDialog :open="issueCreateOpen" @close="issueCreateOpen = false" />
    <MilestoneCreateDialog :open="milestoneCreateOpen" @close="milestoneCreateOpen = false" />
  </PanelShell>
</template>

<style scoped>
.list-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 10px;
}
.toolbar-spacer {
  flex: 1;
}
.state-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.state-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  height: 22px;
  padding: 0 9px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.state-tab:hover {
  background: var(--bg-hover);
}
.state-tab.active {
  background: var(--bg-selected);
  color: var(--accent);
  font-weight: 600;
}
.refresh-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  height: 22px;
  padding: 0 12px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.refresh-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.refresh-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.create-btn {
  color: var(--accent);
  border-color: var(--accent);
}
.create-btn.active {
  background: var(--bg-selected);
}
.error-banner {
  margin: 8px 14px 0;
  padding: 8px 10px;
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
}
</style>
