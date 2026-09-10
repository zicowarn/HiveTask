<script setup lang="ts">
/**
 * PanelShell — common panel chrome: a titled pane header (title + actions
 * slot) and a content slot. A panel's internal view modes (e.g. the
 * open/closed tabs) stay local to the panel; if a panel later needs a
 * header-level mode switch, a `mode -> component` map can be added here.
 */
withDefaults(
  defineProps<{
    title?: string;
  }>(),
  { title: "" },
);
</script>

<template>
  <section class="panel-shell">
    <header v-if="title || $slots.actions" class="panel-header">
      <div v-if="title" class="panel-title">{{ title }}</div>
      <div v-if="$slots.actions" class="panel-actions">
        <slot name="actions" />
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
.panel-actions {
  margin-left: auto;
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
