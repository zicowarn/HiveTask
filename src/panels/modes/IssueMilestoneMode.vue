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
import { computed, onMounted, ref, watch } from "vue";
import EditorIcon from "../../components/EditorIcon.vue";
import { api, isTauri } from "../../api";
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
  // 元数据里程碑并入：当前筛选下 0 条也成组（上下文完整；也解决
  // 「新建的空里程碑不出现」的断点）
  for (const title of metaMap.value.keys()) {
    if (!byName.has(title)) byName.set(title, []);
  }

  const named = [...byName.keys()]
    .filter((name) => name !== "")
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, issues: byName.get(name)! }));
  const unassigned = byName.get("");
  return unassigned ? [...named, { name: null, issues: unassigned }] : named;
});

/** 仓库是否用过里程碑（元数据或任一 Issue 归属）——决定提示条语义。 */
const hasAnyMilestone = computed(
  () => metaMap.value.size > 0 || groups.value.some((g) => g.name !== null),
);

/** 只剩兜底组 = 仓库完全没用里程碑，分组失去意义——回退平铺 + 说明。 */
const allUnassigned = computed(
  () => groups.value.length === 1 && groups.value[0].name === null,
);

// ---- 里程碑元数据（Due by / Overdue 的数据源）----
interface MilestoneMeta {
  title: string;
  dueOn: string | null;
  state: string;
  openIssues: number;
  closedIssues: number;
}
const metaMap = ref(new Map<string, MilestoneMeta>());

async function loadMeta() {
  const repo = useRepoStore();
  if (!isTauri() || !repo.current) return;
  try {
    const list = await api.milestoneList(repo.current);
    const map = new Map<string, MilestoneMeta>();
    for (const m of list) map.set(m.title.toLowerCase(), m);
    metaMap.value = map;
  } catch {
    metaMap.value = new Map();
  }
}
onMounted(() => void loadMeta());
watch(() => repoStore.current, () => void loadMeta());

function metaOf(group: MilestoneGroup): MilestoneMeta | null {
  return metaMap.value.get((group.name ?? "").toLowerCase()) ?? null;
}

/** 里程碑本体状态徽章：
 * closed = 平台上已关闭的里程碑；
 * closable = Issue 已全部关闭但里程碑未关——提示去平台关闭（GitHub 同款提醒场景）。 */
function stateBadge(group: MilestoneGroup): { text: string; kind: "closed" | "closable" } | null {
  const meta = metaOf(group);
  if (!meta) return null;
  const total = meta.openIssues + meta.closedIssues;
  if (meta.state === "closed") return { text: t("milestone.stateClosed"), kind: "closed" };
  if (total > 0 && meta.openIssues === 0) return { text: t("milestone.closable"), kind: "closable" };
  return null;
}

/** 截止信息：逾期（红）→ 截止日；已关闭里程碑不提示逾期。 */
function dueInfo(group: MilestoneGroup): { text: string; overdue: boolean } | null {
  const meta = metaOf(group);
  if (!meta?.dueOn) return null;
  const due = new Date(meta.dueOn);
  if (Number.isNaN(due.getTime())) return null;
  const dateStr = meta.dueOn.slice(0, 10);
  const overdueDays = Math.ceil((Date.now() - due.getTime()) / 86_400_000);
  if (overdueDays > 0 && meta.state !== "closed") {
    return { text: t("milestone.overdueBy", { n: overdueDays }), overdue: true };
  }
  return { text: t("milestone.dueBy", { date: dateStr }), overdue: false };
}

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
function collapseAll() {
  collapsed.value = new Set(groups.value.map((g) => g.name ?? "__none__"));
}
function expandAll() {
  collapsed.value = new Set();
}

function closedOf(group: MilestoneGroup): number {
  const meta = metaOf(group);
  if (meta) return meta.closedIssues;
  return group.issues.filter((i) => i.state === "CLOSED").length;
}
function totalOf(group: MilestoneGroup): number {
  const meta = metaOf(group);
  if (meta) return meta.openIssues + meta.closedIssues;
  return group.issues.length;
}

/** 组内 Issue 的最近更新：绝对日期 + 相对时间；无数据返回 null。 */
defineExpose({ collapseAll, expandAll });

function lastUpdatedOf(group: MilestoneGroup): { date: string; rel: string } | null {
  const times = group.issues
    .map((i) => i.updatedAt)
    .filter((v): v is string => !!v)
    .map((v) => new Date(v).getTime())
    .filter((n) => !Number.isNaN(n));
  if (times.length === 0) return null;
  const date = new Date(Math.max(...times)).toISOString().slice(0, 10);
  const diffDays = Math.floor((Date.now() - Math.max(...times)) / 86_400_000);
  const rel =
    diffDays <= 0
      ? t("milestone.updatedToday")
      : diffDays === 1
        ? t("milestone.updatedYesterday")
        : t("milestone.updatedDaysAgo", { n: diffDays });
  return { date, rel };
}
</script>

<template>
  <div v-if="!loading && issues.length === 0" class="empty-row">
    {{ t(emptyKey) }}
  </div>
  <div v-else class="milestone-scroll">
    <p v-if="allUnassigned && !hasAnyMilestone" class="unassigned-note">
      {{ t("milestone.noneInUse") }}
    </p>
    <template v-if="allUnassigned && !hasAnyMilestone">
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
          <span
            v-if="stateBadge(group)"
            class="group-state-badge"
            :class="stateBadge(group)!.kind"
          >{{ stateBadge(group)!.text }}</span>
          <span
            v-if="dueInfo(group)"
            class="group-due"
            :class="{ overdue: dueInfo(group)!.overdue }"
          >{{ dueInfo(group)!.text }}</span>
          <span v-if="lastUpdatedOf(group)" class="group-updated">
            {{ t("milestone.updatedPrefix") }} {{ lastUpdatedOf(group)!.date }} · {{ lastUpdatedOf(group)!.rel }}
          </span>
          <span class="group-spacer"></span>
          <span
            class="group-tag"
            :class="{ done: totalOf(group) > 0 && closedOf(group) === totalOf(group) }"
            :title="t('milestone.progressTitle', { done: closedOf(group), total: totalOf(group) })"
          >{{ closedOf(group) }}/{{ totalOf(group) }}</span>
        </header>
        <ul v-if="!isCollapsed(group.name)" class="item-list">
          <IssueRow v-for="issue in group.issues" :key="issue.number" :issue="issue" />
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
<style scoped>
.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
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
  font-size: var(--font-sm);
  flex: none;
}
.group-state-badge {
  flex: none;
  font-size: var(--font-xs);
  padding: 0 6px;
  height: 16px;
  line-height: 14px;
  border-radius: 4px;
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.group-state-badge.closable {
  color: var(--warning);
  border-color: var(--warning);
}
.group-due {
  color: var(--text-dim);
  font-size: var(--font-sm);
  flex: none;
}
.group-due.overdue {
  color: var(--danger);
  font-weight: 600;
}
.group-updated {
  color: var(--text-dim);
  font-size: var(--font-sm);
  flex: none;
}
.group-spacer {
  flex: 1;
}
/* 完成度标签（el-tag 形态）：默认中性，全部完成点亮 success */
.group-tag {
  flex: none;
  font-size: var(--font-sm);
  padding: 0 7px;
  height: 18px;
  line-height: 16px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text-dim);
}
.group-tag.done {
  border-color: var(--success);
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, transparent);
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
  font-size: var(--font-sm);
}
.group-name {
  font-size: var(--font-base);
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
  font-size: var(--font-md);
  color: var(--text-dim);
  background: var(--bg-chip);
  border: 1px solid var(--border);
  border-radius: 6px;
}
.empty-row {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-dim);
  font-size: var(--font-md);
}
</style>
