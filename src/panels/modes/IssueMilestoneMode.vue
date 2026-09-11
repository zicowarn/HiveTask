<script setup lang="ts">
/**
 * Issue panel "milestone" mode: issues grouped by milestone, matching the
 * old Qt client's IssueMilestone view. Named milestones sort alphabetically;
 * issues without one collapse into a trailing "no milestone" group
 * (label: `common.unassignedMilestone`).
 * Order inside a group follows the store's sync order (recently updated first).
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import IssueRow from "../IssueRow.vue";
import { useIssuesStore } from "../../stores/issues";
import { useI18n } from "../../i18n";
import type { Issue } from "../../types";

interface MilestoneGroup {
  name: string | null;
  issues: Issue[];
}

const store = useIssuesStore();
const { issues, loading } = storeToRefs(store);
const { t } = useI18n();

const groups = computed<MilestoneGroup[]>(() => {
  const byName = new Map<string, Issue[]>();
  for (const issue of issues.value) {
    const key = issue.milestone ?? "";
    const bucket = byName.get(key);
    if (bucket) bucket.push(issue);
    else byName.set(key, [issue]);
  }

  const named = [...byName.keys()]
    .filter((name) => name !== "")
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, issues: byName.get(name)! }));
  const unassigned = byName.get("");
  return unassigned ? [...named, { name: null, issues: unassigned }] : named;
});
</script>

<template>
  <div v-if="!loading && issues.length === 0" class="empty-row">
    {{ t("common.empty") }}
  </div>
  <div v-else class="milestone-scroll">
    <section v-for="group in groups" :key="group.name ?? '__none'" class="milestone-group">
      <header class="group-header">
        <span class="group-name" :class="{ unassigned: group.name === null }">
          {{ group.name ?? t("common.unassignedMilestone") }}
        </span>
        <span class="group-count">{{ group.issues.length }}</span>
      </header>
      <ul class="item-list">
        <IssueRow v-for="issue in group.issues" :key="issue.number" :issue="issue" />
      </ul>
    </section>
  </div>
</template>

<style scoped>
.milestone-scroll {
  overflow-y: auto;
  flex: 1;
  padding-bottom: 8px;
}
.milestone-group {
  display: flex;
  flex-direction: column;
}
.group-header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}
.group-name {
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-name.unassigned {
  color: var(--text-dim);
  font-weight: 500;
  font-style: italic;
}
.group-count {
  margin-left: auto;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.item-list {
  list-style: none;
  margin: 0;
  padding: 4px 6px;
}
.empty-row {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}
</style>
