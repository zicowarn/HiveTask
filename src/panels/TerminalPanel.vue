<script setup lang="ts">
/**
 * Terminal panel — placeholder for the xterm.js + portable-pty integrated
 * terminal (per-OS shell selectable in settings). See TASK.md P2;
 * component evaluation in the knowledge base (架构设计-工具工作区).
 */
import PanelShell from "../workbench/PanelShell.vue";
import { useI18n } from "../i18n";

defineProps<{ leafId?: string; panelType?: string }>();
const { t } = useI18n();
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <div class="placeholder">
      <span class="placeholder-mark">❯_</span>
      <p>{{ t("terminal.placeholder") }}</p>
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
  font-size: 26px;
  color: var(--accent);
  opacity: 0.6;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.placeholder p {
  margin: 0;
  max-width: 320px;
  line-height: 1.7;
}
</style>
