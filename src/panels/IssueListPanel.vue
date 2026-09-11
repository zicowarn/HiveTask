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

const states: { value: IssueState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];
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
          {{ s.label }}
        </button>
      </div>
      <button class="refresh-btn" :disabled="loading" @click="store.refresh()">
        {{ loading ? t("common.syncing") : t("common.refresh") }}
      </button>
    </template>

    <p v-if="error" class="error-banner">{{ error }}</p>

    <component :is="activeMode.component" />
  </PanelShell>
</template>

<style scoped>
.state-tabs {
  display: flex;
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
