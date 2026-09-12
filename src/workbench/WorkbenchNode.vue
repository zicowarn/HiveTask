<script setup lang="ts">
/**
 * Recursive layout renderer. A leaf renders its registered panel and hands
 * the layout leaf id through as `leafId` so PanelShell can split/close it;
 * a split node renders a SplitPane whose two slots are further WorkbenchNodes.
 * Self-reference by filename gives the recursion. Ratio changes go through
 * the store's setRatio (one-way data flow: never mutate props in place).
 */
import SplitPane from "./SplitPane.vue";
import { resolvePanel } from "./registry";
import { useWorkbenchStore } from "../stores/workbench";
import type { LayoutNode } from "../stores/workbench";

defineProps<{ node: LayoutNode }>();

const workbench = useWorkbenchStore();

function resolve(type: string) {
  return resolvePanel(type).component;
}
</script>

<template>
  <component
    v-if="node.type === 'leaf'"
    :is="resolve(node.panel)"
    :leaf-id="node.id"
    :panel-type="node.panel"
  />
  <SplitPane
    v-else
    :direction="node.dir === 'h' ? 'horizontal' : 'vertical'"
    :ratio="node.ratio"
    :min="0.18"
    @update:ratio="workbench.setRatio(node.id, $event)"
  >
    <template #first>
      <WorkbenchNode :node="node.first" />
    </template>
    <template #second>
      <WorkbenchNode :node="node.second" />
    </template>
  </SplitPane>
</template>
