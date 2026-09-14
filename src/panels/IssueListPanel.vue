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
import { resolvePanel } from "../workbench/registry";
import { useIssuesStore } from "../stores/issues";
import { useRepoStore } from "../stores/repo";
import { api } from "../api";
import { pushToast } from "../toast";
import { translateError } from "../gh-errors";
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
const { state, loading, error, issues } = storeToRefs(store);

const storedMode =
  modes.find((m) => m.key === localStorage.getItem(MODE_STORAGE_KEY))?.key ?? modes[0]?.key;
const modeKey = ref(storedMode);
watch(modeKey, (key) => localStorage.setItem(MODE_STORAGE_KEY, key));

const activeMode = computed(() => modes.find((m) => m.key === modeKey.value) ?? modes[0]);

const states: { value: IssueState }[] = [
  { value: "open" },
  { value: "closed" },
  { value: "all" },
];

const createOpen = ref(false);
const createTitle = ref("");
const createBody = ref("");
const createMilestone = ref("");
const milestoneOpen = ref(false);
const msName = ref("");
const msDue = ref("");
const msDesc = ref("");

/** 里程碑选项：来自当前列表已加载的分组（无需额外 API）。 */
const milestoneChoices = computed(() => {
  const names = new Set<string>();
  for (const i of issues.value) if (i.milestone) names.add(i.milestone);
  return [...names].sort((a, b) => a.localeCompare(b));
});

const isMilestoneMode = computed(() => activeMode.value?.key === "milestone");

async function submitCreate() {
  if (!createTitle.value.trim()) return;
  await store.createIssue(
    createTitle.value,
    createBody.value || undefined,
    createMilestone.value || undefined,
  );
  if (!store.error) {
    createOpen.value = false;
    createTitle.value = "";
    createBody.value = "";
    createMilestone.value = "";
  }
}

async function submitMilestone() {
  if (!msName.value.trim()) return;
  try {
    await api.createMilestone(repoStore.current ?? "", msName.value, msDue.value || undefined, msDesc.value || undefined);
    pushToast({ kind: "success", message: t("milestone.createdToast", { name: msName.value }) });
    milestoneOpen.value = false;
    msName.value = "";
    msDue.value = "";
    msDesc.value = "";
  } catch (e) {
    error.value = translateError(String(e));
  }
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template v-if="modes.length > 1" #switcher>
      <ModeTabs v-model="modeKey" :modes="modes" />
    </template>
    <div class="list-toolbar">
      <div class="state-tabs">
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
      <span class="toolbar-spacer"></span>
      <button class="refresh-btn" :disabled="loading" @click="store.refresh()">
        {{ loading ? t("common.syncing") : t("common.refresh") }}
      </button>
      <button class="refresh-btn create-btn" @click="((createOpen = !createOpen), (milestoneOpen = false))">
        {{ t("issue.createBtn") }}
      </button>
      <button
        v-if="isMilestoneMode"
        class="refresh-btn create-btn"
        :class="{ active: milestoneOpen }"
        @click="((milestoneOpen = !milestoneOpen), (createOpen = false))"
      >
        {{ t("milestone.createBtn") }}
      </button>
    </div>

    <p v-if="error" class="error-banner">{{ error }}</p>

    <div v-if="createOpen" class="create-form">
      <input
        v-model="createTitle"
        class="create-title"
        :placeholder="t('issue.titlePlaceholder')"
        spellcheck="false"
        @keydown.enter="submitCreate"
      />
      <textarea
        v-model="createBody"
        class="create-body"
        :placeholder="t('issue.bodyPlaceholder')"
        rows="3"
      />
      <select v-model="createMilestone" class="create-milestone" v-if="milestoneChoices.length">
        <option value="">{{ t("issue.milestoneOptional") }}</option>
        <option v-for="m in milestoneChoices" :key="m" :value="m">{{ m }}</option>
      </select>
      <div class="create-actions">
        <button class="create-cancel" @click="createOpen = false">
          {{ t("conn.cancel") }}
        </button>
        <button
          class="create-submit"
          :disabled="!createTitle.trim()"
          @click="submitCreate"
        >
          {{ t("issue.submit") }}
        </button>
      </div>
    </div>

    <div v-if="milestoneOpen && isMilestoneMode" class="create-form">
      <input
        v-model="msName"
        class="create-title"
        :placeholder="t('milestone.namePh')"
        spellcheck="false"
        @keydown.enter="submitMilestone"
      />
      <div class="ms-row">
        <input v-model="msDue" type="date" class="create-title ms-date" />
        <input
          v-model="msDesc"
          class="create-title"
          :placeholder="t('milestone.descPh')"
          spellcheck="false"
          @keydown.enter="submitMilestone"
        />
      </div>
      <div class="create-actions">
        <button class="create-cancel" @click="milestoneOpen = false">
          {{ t("conn.cancel") }}
        </button>
        <button
          class="create-submit"
          :disabled="!msName.trim()"
          @click="submitMilestone"
        >
          {{ t("issue.submit") }}
        </button>
      </div>
    </div>

    <component :is="activeMode.component" />
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
  font-size: 12px;
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
  font-size: 12px;
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
.create-milestone {
  box-sizing: border-box;
  width: 100%;
  font-size: 12px;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 5px 8px;
}
.ms-row {
  display: flex;
  gap: 6px;
}
.ms-date {
  flex: none;
  width: 150px;
}
.create-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 10px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-app);
}
.create-title,
.create-body {
  box-sizing: border-box;
  width: 100%;
  font-size: 12px;
  font-family: inherit;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 6px 8px;
  outline: none;
  resize: vertical;
}
.create-title:focus,
.create-body:focus {
  border-color: var(--accent);
}
.create-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.create-cancel,
.create-submit {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 12px;
  height: 24px;
  padding: 0 12px;
  border-radius: 5px;
  cursor: pointer;
}
.create-submit {
  color: var(--accent);
  border-color: var(--accent);
  font-weight: 600;
}
.create-submit:disabled {
  opacity: 0.5;
  cursor: default;
}
.create-cancel:hover,
.create-submit:not(:disabled):hover {
  border-color: var(--accent);
  color: var(--accent);
}
.error-banner {
  margin: 8px 14px 0;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
}
</style>
