<script setup lang="ts">
/**
 * Git history panel — placeholder for the git2-rs-backed commit graph
 * (local + remote branches, ahead/behind). See TASK.md P2; component
 * evaluation in the knowledge base (架构设计-工具工作区).
 */
import PanelShell from "../workbench/PanelShell.vue";
import { useI18n } from "../i18n";

defineProps<{ leafId?: string; panelType?: string }>();
const { t } = useI18n();
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <div class="placeholder">
      <span class="placeholder-mark">⑂</span>
      <p>{{ t("gitHistory.placeholder") }}</p>
    </div>
  </PanelShell>
</template>

<style scoped>
.placeholder {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-dim);
  font-size: 13px;
  padding: 24px;
  text-align: center;
}
.placeholder-mark {
  font-size: 30px;
  color: var(--accent);
  opacity: 0.6;
}
.placeholder p {
  margin: 0;
  max-width: 320px;
  line-height: 1.7;
}
</style>
