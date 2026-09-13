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
import { useI18n } from "../i18n";
import { stateLabel } from "./state-label";
import type { IssueState } from "../types";

defineProps<{ leafId?: string; panelType?: string }>();

const PANEL_TYPE = "issue.list";
const MODE_STORAGE_KEY = "hivetask.panel-mode.issue.list";

const def = resolvePanel(PANEL_TYPE);
const modes = def.modes ?? [];

const store = useIssuesStore();
const { t } = useI18n();
const { state, loading, error } = storeToRefs(store);

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
async function submitCreate() {
  if (!createTitle.value.trim()) return;
  await store.createIssue(createTitle.value, createBody.value || undefined);
  if (!store.error) {
    createOpen.value = false;
    createTitle.value = "";
    createBody.value = "";
  }
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template v-if="modes.length > 1" #switcher>
      <ModeTabs v-model="modeKey" :modes="modes" />
    </template>
    <template #actions>
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
      <button class="refresh-btn" :disabled="loading" @click="store.refresh()">
        {{ loading ? t("common.syncing") : t("common.refresh") }}
      </button>
      <button
        class="refresh-btn create-btn"
        @click="createOpen = !createOpen"
      >
        {{ t("issue.createBtn") }}
      </button>
    </template>

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

    <component :is="activeMode.component" />
  </PanelShell>
</template>

<style scoped>
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
