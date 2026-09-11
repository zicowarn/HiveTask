<script setup lang="ts">
/**
 * PanelShell — common panel chrome: a pane header (Editor type switcher +
 * actions slot) and a content slot. A panel's internal view modes (e.g. the
 * open/closed tabs) stay local to the panel.
 *
 * When rendered inside the workbench layout tree, the host passes its
 * `leafId` and `panelType`; the header then shows a panel-type dropdown
 * (Editor switcher) plus split-h / split-v / close controls that reshape the
 * layout through the workbench store.
 */
import { computed } from "vue";
import { useWorkbenchStore } from "../stores/workbench";
import { panelTypes } from "./panel-types";

const props = defineProps<{
  leafId?: string;
  panelType?: string;
}>();

const workbench = useWorkbenchStore();
const switchableTypes = panelTypes;

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
    <header v-if="$slots.actions || leafId" class="panel-header">
      <div v-if="leafId && panelType" class="panel-type">
        <select
          class="panel-type-select"
          :value="panelType"
          title="切换面板类型"
          @change="onTypeChange"
        >
          <option v-for="p in switchableTypes" :key="p.type" :value="p.type">
            {{ p.title }}
          </option>
        </select>
      </div>
      <div class="panel-header-right">
        <div v-if="$slots.actions" class="panel-actions">
          <slot name="actions" />
        </div>
        <div v-if="leafId" class="layout-actions">
          <button class="icon-btn" title="左右分屏" @click="split('h')">▥</button>
          <button class="icon-btn" title="上下分屏" @click="split('v')">▤</button>
          <button class="icon-btn close-btn" title="关闭面板" :disabled="!canClose" @click="close">✕</button>
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
.panel-type {
  flex: none;
  min-width: 0;
}
.panel-type-select {
  max-width: 150px;
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  font-size: 12px;
  font-weight: 600;
  padding: 3px 6px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.panel-type-select:hover {
  border-color: var(--accent);
  color: var(--accent);
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
