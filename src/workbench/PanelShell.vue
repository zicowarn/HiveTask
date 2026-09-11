<script setup lang="ts">
/**
 * PanelShell — common panel chrome: a pane header and a content slot.
 *
 * Header layout groups controls by role:
 *  - left: view switchers — the Editor panel-type dropdown and the
 *    `switcher` slot (a panel's Mode tabs);
 *  - right: data/layout actions — the `actions` slot and split/close.
 *
 * When rendered inside the workbench layout tree, the host passes its
 * `leafId` and `panelType`; the header then shows the panel-type dropdown
 * plus split-h / split-v / close controls that reshape the layout through
 * the workbench store.
 */
import { computed } from "vue";
import { useWorkbenchStore } from "../stores/workbench";
import { useI18n } from "../i18n";
import { panelTypes } from "./panel-types";

const props = defineProps<{
  leafId?: string;
  panelType?: string;
}>();

const workbench = useWorkbenchStore();
const { t } = useI18n();

const canClose = computed(() => (props.leafId ? workbench.canCloseLeaf(props.leafId) : false));

function split(dir: "h" | "v") {
  if (props.leafId) workbench.splitLeaf(props.leafId, dir);
}
function close() {
  if (props.leafId) workbench.closeLeaf(props.leafId);
}
function onTypeChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (props.leafId && value) workbench.setLeafPanel(props.leafId, value);
}
</script>

<template>
  <section class="panel-shell">
    <header v-if="$slots.switcher || $slots.actions || leafId" class="panel-header">
      <div class="panel-header-left">
        <select
          v-if="leafId && panelType"
          class="panel-type-select"
          :value="panelType"
          :title="t('panel.switchType')"
          @change="onTypeChange"
        >
          <option v-for="p in panelTypes" :key="p.type" :value="p.type">
            {{ t(p.titleKey) }}
          </option>
        </select>
        <div v-if="$slots.switcher" class="panel-switcher">
          <slot name="switcher" />
        </div>
      </div>

      <div class="panel-header-right">
        <div v-if="$slots.actions" class="panel-actions">
          <slot name="actions" />
        </div>
        <div v-if="leafId" class="layout-actions">
          <button class="icon-btn" :title="t('panel.splitH')" @click="split('h')">▥</button>
          <button class="icon-btn" :title="t('panel.splitV')" @click="split('v')">▤</button>
          <button class="icon-btn close-btn" :title="t('panel.close')" :disabled="!canClose" @click="close">✕</button>
        </div>
      </div>
    </header>
    <div class="panel-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg-panel);
}
.panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
/* Left cluster: Editor type + Mode switchers, visually aligned. */
.panel-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.panel-switcher {
  display: flex;
  align-items: center;
}
/* Same chrome metrics as ModeTabs: 22px tall, 6px radius, quiet colors.
   appearance:none removes the native macOS aqua bezel/gradient; a flat
   background plus a small chevron keeps the affordance. */
.panel-type-select {
  appearance: none;
  -webkit-appearance: none;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background-color: var(--bg-app);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' fill='none' stroke='%239aa0a8' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 5px center;
  background-size: 8px;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
  padding: 0 18px 0 7px;
  cursor: pointer;
  outline: none;
}
.panel-type-select:hover,
.panel-type-select:focus-visible {
  color: var(--text);
  border-color: var(--accent);
}
.panel-header-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.layout-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.icon-btn {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1;
  border-radius: 5px;
  cursor: pointer;
  padding: 0;
}
.icon-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text);
}
.icon-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
.close-btn:hover:not(:disabled) {
  color: #f87171;
}
.panel-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.panel-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
