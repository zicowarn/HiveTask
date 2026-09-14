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
import { computed, ref } from "vue";
import EditorIcon from "../../components/EditorIcon.vue";
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

// 本地仓库没有"远端"，空态引导创建而非刷新。
const emptyKey = computed(() =>
  !repoStore.current
    ? "issue.emptyRepo"
    : repoStore.platform === "local"
      ? "issue.localEmpty"
      : "common.empty",
);

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

// ---- 可折叠分组（对齐 GitHub 里程碑页的进度语义）----
const collapsed = ref(new Set<string>());
function toggleGroup(name: string | null) {
  const key = name ?? "__none__";
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}
function isCollapsed(name: string | null): boolean {
  return collapsed.value.has(name ?? "__none__");
}
function closedOf(group: MilestoneGroup): number {
  return group.issues.filter((i) => i.state === "CLOSED").length;
}

/** 组内 Issue 的最近更新（相对时间）；无数据返回空串。 */
function lastUpdatedOf(group: MilestoneGroup): string {
  const times = group.issues
    .map((i) => i.updatedAt)
    .filter((v): v is string => !!v)
    .map((v) => new Date(v).getTime())
    .filter((n) => !Number.isNaN(n));
  if (times.length === 0) return "";
  const diffDays = Math.floor((Date.now() - Math.max(...times)) / 86_400_000);
  if (diffDays <= 0) return t("milestone.updatedToday");
  if (diffDays === 1) return t("milestone.updatedYesterday");
  return t("milestone.updatedDaysAgo", { n: diffDays });
}
</script>

<template>
  <div v-if="!loading && issues.length === 0" class="empty-row">
    {{ t(emptyKey) }}
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
        <header
          class="group-header"
          role="button"
          :title="t('milestone.toggleGroup')"
          @click="toggleGroup(group.name)"
        >
          <EditorIcon
            class="group-caret"
            :class="{ open: !isCollapsed(group.name) }"
            name="chevron"
          />
          <span class="group-name" :class="{ unassigned: group.name === null }">
            {{ group.name ?? t("common.unassignedMilestone") }}
          </span>
          <span class="group-progress" :title="t('milestone.progressTitle', { done: closedOf(group), total: group.issues.length })">
            <span class="group-bar">
              <span
                class="group-bar-fill"
                :style="{ width: (group.issues.length ? (closedOf(group) / group.issues.length) * 100 : 0) + '%' }"
              ></span>
            </span>
            <span class="group-count">{{ closedOf(group) }}/{{ group.issues.length }}</span>
          </span>
          <span v-if="lastUpdatedOf(group)" class="group-updated">{{ lastUpdatedOf(group) }}</span>
        </header>
        <ul v-if="!isCollapsed(group.name)" class="item-list">
          <IssueRow v-for="issue in group.issues" :key="issue.number" :issue="issue" />
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  cursor: pointer;
  user-select: none;
}
.group-header:hover {
  background: var(--bg-hover);
}
.group-caret {
  color: var(--text-dim);
  transition: transform 0.12s;
}
.group-caret.open {
  transform: rotate(90deg);
}
.group-updated {
  color: var(--text-dim);
  font-size: 11px;
  flex: none;
}
.group-progress {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
}
.group-bar {
  width: 64px;
  height: 5px;
  border-radius: 3px;
  background: var(--bg-hover);
  overflow: hidden;
}
.group-bar-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--success);
}
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
