<script setup lang="ts">
/**
 * PanelShell — common panel chrome: a titled pane header (title + actions
 * slot) and a content slot. A panel's internal view modes (e.g. the
 * open/closed tabs) stay local to the panel.
 *
 * When rendered inside the workbench layout tree, the host passes its
 * `leafId`; the header then shows split-h / split-v / close controls that
 * reshape the layout through the workbench store.
 */
import { computed } from "vue";
import { useWorkbenchStore } from "../stores/workbench";

const props = withDefaults(
  defineProps<{
    title?: string;
    leafId?: string;
  }>(),
  { title: "", leafId: undefined },
);

const workbench = useWorkbenchStore();
const canClose = computed(() => (props.leafId ? workbench.canCloseLeaf(props.leafId) : false));

function split(dir: "h" | "v") {
  if (props.leafId) workbench.splitLeaf(props.leafId, dir);
}
function close() {
  if (props.leafId) workbench.closeLeaf(props.leafId);
}
</script>

<template>
  <section class="panel-shell">
    <header v-if="title || $slots.actions || leafId" class="panel-header">
      <div v-if="title" class="panel-title">{{ title }}</div>
      <div class="panel-header-right">
        <div v-if="leafId" class="layout-actions">
          <button class="icon-btn" title="左右分屏" @click="split('h')">▥</button>
          <button class="icon-btn" title="上下分屏" @click="split('v')">▤</button>
          <button class="icon-btn close-btn" title="关闭面板" :disabled="!canClose" @click="close">✕</button>
        </div>
        <div v-if="$slots.actions" class="panel-actions">
          <slot name="actions" />
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
.panel-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
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
