<script setup lang="ts">
/**
 * Issue list panel, rendered inside a workbench pane.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useIssuesStore } from "../stores/issues";
import type { IssueState } from "../types";

const store = useIssuesStore();
const { issues, state, loading, error, selectedNumber } = storeToRefs(store);

const states: { value: IssueState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

const timeLabel = computed(() => {
  // gh ISO timestamps are UTC; display the date portion only.
  return (iso?: string | null) => (iso ? iso.slice(0, 10) : "");
});
</script>

<template>
  <section class="panel issue-list-panel">
    <header class="panel-header">
      <div class="panel-title">Issues</div>
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
        {{ loading ? "同步中…" : "刷新" }}
      </button>
    </header>

    <p v-if="error" class="error-banner">{{ error }}</p>

    <ul class="issue-list">
      <li
        v-for="issue in issues"
        :key="issue.number"
        class="issue-row"
        :class="{ active: issue.number === selectedNumber }"
        @click="store.select(issue)"
      >
        <div class="issue-main">
          <span class="issue-title">{{ issue.title }}</span>
          <span class="issue-meta">
            #{{ issue.number }}
            <template v-if="issue.author"> · {{ issue.author }}</template>
            <template v-if="timeLabel(issue.updatedAt)"> · {{ timeLabel(issue.updatedAt) }}</template>
          </span>
        </div>
        <div class="issue-tags">
          <span
            v-for="label in issue.labels.slice(0, 3)"
            :key="label"
            class="issue-label"
          >{{ label }}</span>
        </div>
      </li>
      <li v-if="!loading && issues.length === 0" class="empty-row">
        暂无数据，点击「刷新」从 GitHub 拉取
      </li>
    </ul>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
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
}
.state-tabs {
  display: flex;
  gap: 2px;
  margin-left: 8px;
}
.state-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  padding: 3px 9px;
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
  margin-left: auto;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 5px;
  cursor: pointer;
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
  color: #f87171;
  background: rgba(248, 113, 113, 0.08);
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: 6px;
}
.issue-list {
  list-style: none;
  margin: 0;
  padding: 4px 6px;
  overflow-y: auto;
  flex: 1;
}
.issue-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.issue-row:hover {
  background: var(--bg-hover);
}
.issue-row.active {
  background: var(--bg-selected);
}
.issue-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.issue-title {
  font-size: 13px;
  color: var(--text);
  line-height: 1.4;
}
.issue-meta {
  font-size: 11px;
  color: var(--text-dim);
}
.issue-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.issue-label {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-chip);
  color: var(--text-dim);
  border: 1px solid var(--border);
}
.empty-row {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  list-style: none;
}
</style>
