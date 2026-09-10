<script setup lang="ts">
/**
 * One issue row, shared by the flat list mode and the milestone grouping
 * mode. Selection lives in the issues store, so both views stay in sync.
 */
import { storeToRefs } from "pinia";
import { useIssuesStore } from "../stores/issues";
import type { Issue } from "../types";

defineProps<{ issue: Issue }>();

const store = useIssuesStore();
const { selectedNumber } = storeToRefs(store);

function timeLabel(iso?: string | null): string {
  // gh ISO timestamps are UTC; display the date portion only.
  return iso ? iso.slice(0, 10) : "";
}
</script>

<template>
  <li
    class="item-row"
    :class="{ active: issue.number === selectedNumber }"
    @click="store.select(issue)"
  >
    <div class="item-main">
      <span class="item-title">{{ issue.title }}</span>
      <span class="item-meta">
        #{{ issue.number }}
        <template v-if="issue.author"> · {{ issue.author }}</template>
        <template v-if="timeLabel(issue.updatedAt)"> · {{ timeLabel(issue.updatedAt) }}</template>
      </span>
    </div>
    <div class="item-tags">
      <span
        v-for="label in issue.labels.slice(0, 3)"
        :key="label"
        class="chip"
      >{{ label }}</span>
    </div>
  </li>
</template>

<style scoped>
.item-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  list-style: none;
}
.item-row:hover {
  background: var(--bg-hover);
}
.item-row.active {
  background: var(--bg-selected);
}
.item-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.item-title {
  font-size: 13px;
  color: var(--text);
  line-height: 1.4;
}
.item-meta {
  font-size: 11px;
  color: var(--text-dim);
}
.item-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chip {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-chip);
  color: var(--text-dim);
  border: 1px solid var(--border);
}
</style>
