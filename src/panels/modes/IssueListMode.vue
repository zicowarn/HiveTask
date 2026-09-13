<script setup lang="ts">
/**
 * Issue panel "list" mode: the flat issue list in sync order.
 * Hosted by IssueListPanel; state filtering and refresh live in the store.
 */
import { storeToRefs } from "pinia";
import IssueRow from "../IssueRow.vue";
import { useIssuesStore } from "../../stores/issues";
import { useRepoStore } from "../../stores/repo";
import { useI18n } from "../../i18n";

const store = useIssuesStore();
const { issues, loading } = storeToRefs(store);
const repoStore = useRepoStore();
const { t } = useI18n();
</script>

<template>
  <ul class="item-list">
    <li v-if="loading" class="load-row" :class="{ centered: issues.length === 0 }">
      <span class="load-spin"></span>{{ t("list.loading") }}
    </li>
    <IssueRow v-for="issue in issues" :key="issue.number" :issue="issue" />
    <li v-if="!loading && issues.length === 0" class="empty-row">
      {{ t(repoStore.current ? "common.empty" : "issue.emptyRepo") }}
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
.load-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-dim);
}
.load-row.centered {
  justify-content: center;
  padding: 26px 12px;
}
.load-spin {
  width: 12px;
  height: 12px;
  flex: none;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.empty-row {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  list-style: none;
}
</style>
