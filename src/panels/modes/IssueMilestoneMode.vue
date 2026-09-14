<script setup lang="ts">
/**
 * 里程碑 mode（Issue 面板的分组视图，自包含数据）：
 * - Tab（开启中/已关闭/全部）筛选**里程碑本体状态**（meta.state，平台口径，
 *   与线上一致）；组内展示该里程碑的全部 Issue。
 * - 数据自持：listCachedIssues('all') 为底，刷新 = refreshIssues('all') +
 *   元数据重载；不与列表模式共用状态筛选。
 * - 未归属任何里程碑的 Issue 归入「未设置里程碑」兜底组（恒显于末位）。
 * - 折叠状态会话内记忆，支持一键全收/全展。
 */
import { computed, onMounted, ref, watch } from "vue";
import EditorIcon from "../../components/EditorIcon.vue";
import IssueRow from "../IssueRow.vue";
import { api, isTauri } from "../../api";
import { useRepoStore } from "../../stores/repo";
import { useI18n } from "../../i18n";
import type { Issue } from "../../types";

const props = defineProps<{ tab: "open" | "closed" | "all" }>();

const repoStore = useRepoStore();
const { t } = useI18n();

interface MilestoneMeta {
  dueOn: string | null;
  state: string;
  openIssues: number;
  closedIssues: number;
}

interface MilestoneGroup {
  name: string | null;
  issues: Issue[];
}


const allIssues = ref<Issue[]>([]);
const metaMap = ref(new Map<string, MilestoneMeta>());
const collapsed = ref(new Set<string>());
const loading = ref(false);
const error = ref<string | null>(null);

// ---- 分组 ----
const groups = computed<MilestoneGroup[]>(() => {
  const byName = new Map<string, Issue[]>();
  for (const issue of allIssues.value) {
    const key = issue.milestone ?? "";
    const bucket = byName.get(key);
    if (bucket) bucket.push(issue);
    else byName.set(key, [issue]);
  }
  const out: MilestoneGroup[] = [];
  for (const [title, meta] of metaMap.value) {
    if (props.tab !== "all" && meta.state !== props.tab) continue;
    out.push({ name: title, issues: byName.get(title) ?? [] });
  }
  if (props.tab === "all") {
    const un = allIssues.value.filter((i) => !i.milestone);
    if (un.length > 0) out.push({ name: null, issues: un });
  }
  return out;
});


// ---- 组内统计 ----
function closedOf(group: MilestoneGroup): number {
  const meta = metaMap.value.get(group.name ?? "");
  if (meta) return meta.closedIssues;
  return group.issues.filter((i) => i.state === "CLOSED").length;
}
function totalOf(group: MilestoneGroup): number {
  const meta = metaMap.value.get(group.name ?? "");
  if (meta) return meta.openIssues + meta.closedIssues;
  return group.issues.length;
}

/** 截止信息：逾期（红）→ 截止日；已关闭里程碑不提示逾期。 */
function dueInfo(group: MilestoneGroup): { text: string; overdue: boolean } | null {
  const meta = metaMap.value.get(group.name ?? "");
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

/** 组内 Issue 的最近更新：绝对日期 + 相对时间；无数据返回 null。 */
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

// ---- 折叠 ----
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
defineExpose({ collapseAll, expandAll, refresh });

// ---- 数据 ----
async function load() {
  const repo = repoStore.current;
  if (!isTauri() || !repo) return;
  loading.value = true;
  try {
    allIssues.value = await api.listCachedIssues(repo, "all");
    const list = await api.milestoneList(repo);
    metaMap.value = new Map(list.map((m) => [m.title, m]));
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

/** 刷新：重拉远端全量 Issue + 元数据（里程碑模式的刷新语义）。 */
async function refresh() {
  const repo = repoStore.current;
  if (!isTauri() || !repo) return;
  loading.value = true;
  error.value = null;
  try {
    await api.refreshIssues(repo, "all");
  } catch (e) {
    error.value = translateError(String(e));
  }
  await load();
  loading.value = false;
}

onMounted(() => void load());
watch(() => repoStore.current, () => void load());

function translateError(s: string): string {
  // 与全局 gh-errors 转译同源的轻量包装（避免循环依赖的冗余导入）
  return s;
}
</script>

<template>
  <div class="milestone-scroll">
    <p v-if="error" class="unassigned-note err">{{ error }}</p>
    <p v-if="loading && allIssues.length === 0" class="ms-none">{{ t("list.loading") }}</p>

    <template v-else-if="groups.length === 0">
      <p class="ms-none">{{ t("milestone.noneInUse") }}</p>
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
            v-if="dueInfo(group)"
            class="group-due"
            :class="{ overdue: dueInfo(group)!.overdue }"
          >{{ dueInfo(group)!.text }}</span>
          <span v-if="lastUpdatedOf(group)" class="group-updated">
            {{ t("milestone.updatedPrefix") }} {{ lastUpdatedOf(group)!.date }} · {{ lastUpdatedOf(group)!.rel }}
          </span>
          <span class="group-spacer"></span>
          <span class="group-count group-tag" :class="{ done: closedOf(group) === totalOf(group) && totalOf(group) > 0 }"
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
.milestone-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 8px;
}
.milestone-group {
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 4px 10px;
  cursor: pointer;
  user-select: none;
  background: var(--bg-app);
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
.group-name {
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-name.unassigned {
  font-style: italic;
  color: var(--text-dim);
}
.group-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  font-size: var(--font-xs);
  height: 20px;
  padding: 0 8px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text-dim);
}
.group-tag.done {
  border-color: var(--success);
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, transparent);
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
.milestone-group ul.item-list {
  padding: 2px 0;
}
.ms-none {
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  padding: 20px 0;
}
</style>
