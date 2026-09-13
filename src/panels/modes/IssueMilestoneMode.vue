<script setup lang="ts">
/**
 * Issue panel "milestone" mode: issues grouped by milestone, matching the
 * old Qt client's IssueMilestone view. Named milestones sort alphabetically;
 * issues without one collapse into a trailing "no milestone" group
 * (label: `common.unassignedMilestone`).
 * Order inside a group follows the store's sync order (recently updated first).
 * When the repo has NO milestones in use at all (single fallback group),
 * the grouping is pointless — fall back to a flat list with a note.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import IssueRow from "../IssueRow.vue";
import { useIssuesStore } from "../../stores/issues";
import { useRepoStore } from "../../stores/repo";
import { useI18n } from "../../i18n";
import type { Issue } from "../../types";

interface MilestoneGroup {
  name: string | null;
  issues: Issue[];
}

const store = useIssuesStore();
const { issues, loading } = storeToRefs(store);
const repoStore = useRepoStore();
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

/** 只剩兜底组 = 仓库完全没用里程碑，分组失去意义——回退平铺 + 说明。 */
const allUnassigned = computed(
  () => groups.value.length === 1 && groups.value[0].name === null,
);
</script>

<template>
  <div v-if="!loading && issues.length === 0" class="empty-row">
    {{ t(repoStore.current ? "common.empty" : "issue.emptyRepo") }}
  </div>
  <div v-else class="milestone-scroll">
    <p v-if="allUnassigned" class="unassigned-note">{{ t("milestone.noneInUse") }}</p>
    <template v-if="allUnassigned">
      <ul class="item-list">
        <IssueRow v-for="issue in issues" :key="issue.number" :issue="issue" />
      </ul>
    </template>
    <template v-else>
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
    </template>
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
.unassigned-note {
  margin: 0 0 10px;
  padding: 7px 12px;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--bg-chip);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.empty-row {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}
</style>
