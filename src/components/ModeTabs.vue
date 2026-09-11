<script setup lang="ts">
/**
 * Segmented control for switching a panel's modes. Panels own the active
 * key (and persist it per panel type); this is a pure v-model component.
 */
import type { ModeDefinition } from "../workbench/registry";
import { useI18n } from "../i18n";

defineProps<{ modes: ModeDefinition[]; modelValue: string }>();
defineEmits<{ "update:modelValue": [key: string] }>();

// Resolve labels here (not in the registry data) so switching language
// re-renders the tabs.
const { t } = useI18n();
</script>

<template>
  <div class="mode-tabs">
    <button
      v-for="m in modes"
      :key="m.key"
      class="mode-tab"
      :class="{ active: modelValue === m.key }"
      @click="$emit('update:modelValue', m.key)"
    >
      {{ t(m.labelKey) }}
    </button>
  </div>
</template>

<style scoped>
.mode-tabs {
  display: flex;
  gap: 2px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 1px;
}
.mode-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.mode-tab:hover {
  color: var(--text);
}
.mode-tab.active {
  background: var(--bg-selected);
  color: var(--accent);
  font-weight: 600;
}
</style>
