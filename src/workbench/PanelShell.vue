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
import EditorSwitcher from "./EditorSwitcher.vue";

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
function onTypeChange(value: string) {
  if (props.leafId && value) workbench.setLeafPanel(props.leafId, value);
}
</script>

<template>
  <section class="panel-shell">
    <header v-if="$slots.switcher || $slots.actions || leafId" class="panel-header">
      <div class="panel-header-left">
        <EditorSwitcher
          v-if="leafId && panelType"
          :panel-type="panelType"
          @change="onTypeChange"
        />
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
/* Fixed height so every panel chrome is identical regardless of which
   controls it hosts; controls are all normalized to a 22px height. */
.panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 14px;
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
  font-size: var(--icon-size, 14px);
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
  color: var(--danger);
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
