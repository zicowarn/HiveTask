<script setup lang="ts">
/**
 * Issue panel "list" mode: the flat issue list in sync order.
 * Hosted by IssueListPanel; state filtering and refresh live in the store.
 */
import { storeToRefs } from "pinia";
import IssueRow from "../IssueRow.vue";
import { useIssuesStore } from "../../stores/issues";

const store = useIssuesStore();
const { issues, loading } = storeToRefs(store);
</script>

<template>
  <ul class="item-list">
    <IssueRow v-for="issue in issues" :key="issue.number" :issue="issue" />
    <li v-if="!loading && issues.length === 0" class="empty-row">
      暂无数据，点击「刷新」从 GitHub 拉取
    </li>
  </ul>
</template>

<style scoped>
.item-list {
  list-style: none;
  margin: 0;
  padding: 4px 6px;
  overflow-y: auto;
  flex: 1;
}
.empty-row {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  list-style: none;
}
</style>
