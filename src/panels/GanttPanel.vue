<script setup lang="ts">
/**
 * 甘特图 Editor（独立面板，2026-09-21 用户定案：是 Editor 不是 Mode）。
 *
 * 渲染层 = jordium-gantt-vue3（用户拍板引入，2026-09-21）；数据 = Projects
 * 领域模型（跟随所选项目）+ G1 关系数据：
 * - 起止 ← 项目日期字段（拖拽/改宽回写字段值，走 Roadmap 同款写穿透通道）
 * - WBS/依赖/进度 ← 关系数据（GitHub 全量 / Gitea 仅依赖 / Gitee·本地无）
 *
 * 自有的 `gantt-model.ts` 投影（库无关）负责把领域模型算成 WBS 行 + 依赖 +
 * 进度，再由本文件适配成 jordium 的 Task 树——换渲染库不动投影。
 * 主题与字号全部经 --gantt-* → 本应用 token 映射（见文件尾非 scoped 样式）。
 */
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { GanttChart, type Task as JTask } from "jordium-gantt-vue3";
import "jordium-gantt-vue3/index.css";
import PanelShell from "../workbench/PanelShell.vue";
import { useProjectsStore } from "../stores/projects";
import { api, isTauri, type IssueRelations, type ProjectItem } from "../api";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { pushToast } from "../toast";
import { itemTitle } from "./item-fields";
import EditorIcon from "../components/EditorIcon.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import { buildGanttTree, defaultEndField, type GanttNode, type GanttTask } from "./gantt-model";

/** 面板外壳身份：Editor 面板必须经 PanelShell 提供切换器/分栏/关闭
 *  （leafId/panelType 由 WorkbenchNode 透传）。缺了它 = 切进来出不去。 */
defineProps<{ leafId?: string; panelType?: string }>();

const store = useProjectsStore();
const { filteredItems, fields, selectedId, loading: storeLoading } = storeToRefs(store);
const { t, locale } = useI18n();
const { resolvedTheme } = useTheme();

// ---- 日期字段（开始 / 结束）----
const dateFields = computed(() => fields.value.filter((f) => f.kind === "date"));
const startFieldId = ref("");
const startField = computed(
  () => dateFields.value.find((f) => f.id === startFieldId.value) ?? dateFields.value[0] ?? null,
);
/** 结束字段：null = 未手选（默认推断）；"" = 显式「无」；字段 id = 显式选。
 *  甘特语义 = 工期 → 未选时不给「无」，自动落到推断的结束字段上。 */
const endFieldChoice = ref<string | null>(null);
const endField = computed(() => {
  if (endFieldChoice.value !== null) {
    return dateFields.value.find((f) => f.id === endFieldChoice.value) ?? null;
  }
  const id = defaultEndField(dateFields.value, startField.value?.id);
  return dateFields.value.find((f) => f.id === id) ?? null;
});

function dateOf(item: ProjectItem, fieldId: string | null | undefined): string | null {
  if (!fieldId) return null;
  const raw = item.fieldValues[fieldId];
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ---- 关系数据（批量装载：WBS / 进度 / 箭头共用）----
const relationsByKey = ref<Record<string, IssueRelations>>({});
const relationsLoading = ref(false);
const relationsError = ref<string | null>(null);
const relKey = (repoId: string | null, number: string | null) =>
  repoId && number ? `${repoId}::${number}` : "";

/** 为板内全部 issue 条目批量拉关系（每仓一次 GraphQL；已有缓存不重复拉）。 */
async function loadRelations(force = false) {
  if (!isTauri() || !selectedId.value) return;
  const byRepo = new Map<string, string[]>();
  for (const it of filteredItems.value) {
    if (it.kind !== "issue" || !it.repoId || !it.number) continue;
    if (!force && relationsByKey.value[relKey(it.repoId, it.number)]) continue;
    const arr = byRepo.get(it.repoId) ?? [];
    arr.push(it.number);
    byRepo.set(it.repoId, arr);
  }
  if (!byRepo.size) return;
  relationsLoading.value = true;
  relationsError.value = null;
  try {
    const repos = await api.repoList();
    const targets = new Map<string, string>();
    for (const r of repos) {
      const target = r.path || r.remoteUrl || "";
      if (r.id && target) targets.set(r.id, target);
    }
    const merged = { ...relationsByKey.value };
    await Promise.all(
      [...byRepo.entries()].map(async ([repoId, numbers]) => {
        const target = targets.get(repoId);
        if (!target) return;
        const res = await api.issueRelationsBatch(target, numbers);
        for (const [number, relations] of Object.entries(res)) {
          merged[`${repoId}::${number}`] = relations;
        }
      }),
    );
    relationsByKey.value = merged;
  } catch (e) {
    // 关系是投影增强：失败不打断甘特，只诚实提示（条仍按日期画）
    relationsError.value = String(e);
  } finally {
    relationsLoading.value = false;
  }
}

// ---- 投影：条目 → 任务 → WBS 行 → jordium 任务树 ----
const tasks = computed<GanttTask[]>(() =>
  filteredItems.value.map((it) => ({
    id: it.id,
    repoId: it.repoId,
    number: it.number,
    title: itemTitle(it),
    start: dateOf(it, startField.value?.id),
    end: dateOf(it, endField.value?.id),
    closed: (it.entity?.state ?? "").toUpperCase() === "CLOSED",
    relations: relationsByKey.value[relKey(it.repoId, it.number)] ?? null,
  })),
);
const nodes = computed(() => buildGanttTree(tasks.value));
const undatedCount = computed(() => nodes.value.filter((n) => !n.start).length);

/** 数字 id 映射（jordium 的 Task.id 是 number）：条目 id → 序号，正反向各一份。 */
const idOf = computed(() => new Map(nodes.value.map((n, i) => [n.id, i + 1])));
const nodeById = computed(() => new Map(nodes.value.map((n) => [n.id, n])));

/** 折叠状态跨重建保留（库的折叠事件回写到这里）。 */
const collapsed = ref<Set<number>>(new Set());
function onCollapseChange(payload: { taskId?: number; collapsed?: boolean } | number, c?: boolean) {
  const id = typeof payload === "number" ? payload : payload?.taskId;
  const next = typeof payload === "number" ? !!c : !!payload?.collapsed;
  if (typeof id !== "number") return;
  const set = new Set(collapsed.value);
  if (next) set.add(id);
  else set.delete(id);
  collapsed.value = set;
}

/** 扁平行 → jordium 任务树（嵌套 children；投影已保证父在子前）。 */
function toJordiumTasks(flat: GanttNode[]): JTask[] {
  const ids = idOf.value;
  const roots: JTask[] = [];
  const stack: JTask[] = [];
  for (const n of flat) {
    const jid = ids.get(n.id);
    if (!jid) continue;
    const task: JTask = {
      id: jid,
      name: n.title,
      startDate: n.start ?? undefined,
      endDate: n.end ?? undefined,
      progress: n.progress ?? 0,
      predecessor: n.dependsOn.map((d) => ids.get(d) ?? 0).filter((d) => d > 0),
      isParent: n.childCount > 0,
      children: [],
      collapsed: collapsed.value.has(jid),
    };
    stack.length = n.depth;
    if (n.depth === 0 || !stack[n.depth - 1]) {
      roots.push(task);
    } else {
      const parent = stack[n.depth - 1];
      parent.children = parent.children ?? [];
      parent.children.push(task);
      task.parentId = parent.id;
    }
    stack.push(task);
  }
  return roots;
}
/** 交给组件的是普通数组（库会就地改写条上的日期，reactive 数组才跟得上）。 */
const jTasks = ref<JTask[]>([]);
watch(
  nodes,
  (flat) => {
    jTasks.value = toJordiumTasks(flat);
  },
  { immediate: true },
);

// ---- 写回：拖拽 / 改宽 → 项目日期字段（Roadmap 同款 write-through）----

/** 库回传的日期可能是 'YYYY-MM-DD' 或 ISO——取日期部分即可（不做时区换算）。 */
function isoDay(v?: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1] : null;
}

/**
 * 拖拽/改宽结束 → 把新起止写进项目日期字段。
 * 只写有变化的字段；写失败（平台拒绝/断网）由 store 抛错并提示，不吞。
 */
async function onBarDatesChanged(task: JTask) {
  const nodeId = [...idOf.value.entries()].find(([, jid]) => jid === task.id)?.[0];
  const node = nodeId ? nodeById.value.get(nodeId) : undefined;
  if (!node) return;
  const newStart = isoDay(task.startDate);
  const newEnd = isoDay(task.endDate);
  const startFieldRef = startField.value;
  const endFieldRef = endField.value;
  try {
    if (startFieldRef && newStart && newStart !== node.start) {
      await store.setFieldValue(node.id, startFieldRef.id, newStart);
    }
    if (endFieldRef && newEnd && newEnd !== node.end) {
      await store.setFieldValue(node.id, endFieldRef.id, newEnd);
    }
  } catch (e) {
    pushToast({ kind: "error", message: String(e) });
  }
}

// ---- 工具栏（本应用形态：字段选择 + 刻度 + 刷新；不用库自带工具条）----
/** 库的 TimelineScale 未从包入口导出（index.d.ts 实证）——同构本地类型。 */
type GanttScale = "hour" | "day" | "week" | "month" | "quarter" | "year";
const scale = ref<GanttScale>("week");
const scaleOptions = computed(() => [
  { value: "day", label: t("gantt.scaleDay") },
  { value: "week", label: t("gantt.scaleWeek") },
  { value: "month", label: t("gantt.scaleMonth") },
]);

/** 依赖线用应用 token 上色（--gantt-* 映射在文件尾，这里只管语义色）。 */
const linkConfig = {
  type: "orthogonal" as const,
  style: "solid" as const,
  width: 1.2,
  highlightWidth: 2,
};

const taskListConfig = {
  columns: [
    { key: "name", type: "name" as const, width: 260 },
    { key: "startDate", type: "startDate" as const, width: 100 },
    { key: "endDate", type: "endDate" as const, width: 100 },
    { key: "progress", type: "progress" as const, width: 64 },
  ],
  defaultWidth: 380,
  minWidth: 280,
};

// ---- 生命周期 ----
onMounted(() => void loadRelations());
watch(selectedId, () => {
  relationsByKey.value = {};
  collapsed.value = new Set();
  void loadRelations();
});
watch(
  () => filteredItems.value.map((i) => relKey(i.repoId, i.number)).join(","),
  () => void loadRelations(),
);
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <!-- 右栏动作：无日期计数 + 依赖刷新（与看板面板同款 22px 小按钮） -->
    <template #actions>
      <span v-if="undatedCount" class="gt-note">
        {{ t("gantt.undated", { n: String(undatedCount) }) }}
      </span>
      <span v-if="relationsLoading" class="gt-note">{{ t("gantt.depsLoading") }}</span>
      <button v-else class="gt-refresh" :title="t('gantt.refreshDeps')" @click="loadRelations(true)">
        <EditorIcon name="o.sync" />
        <span>{{ t("gantt.refreshDeps") }}</span>
      </button>
    </template>

    <div class="gt">
      <!-- 面板内工具条：日期字段选择 + 刻度（Roadmap mode 同款形态）；
           空态不显示（无项目/无日期字段时无字段可选） -->
      <div v-if="selectedId && dateFields.length" class="gt-toolbar">
        <span class="gt-flex"></span>
        <span class="gt-label">{{ t("gantt.startField") }}</span>
        <DropdownMenu
          class="gt-dd gt-dd-start"
          :options="dateFields.map((f) => ({ value: f.id, label: f.name }))"
          :model-value="startField?.id ?? ''"
          @update:model-value="startFieldId = $event as string"
        />
        <span class="gt-label">{{ t("gantt.endField") }}</span>
        <DropdownMenu
          class="gt-dd gt-dd-end"
          :options="[
            { value: '', label: t('project.none') },
            ...dateFields.map((f) => ({ value: f.id, label: f.name })),
          ]"
          :model-value="endFieldChoice ?? endField?.id ?? ''"
          @update:model-value="endFieldChoice = $event as string"
        />
        <span class="gt-label">{{ t("gantt.scale") }}</span>
        <DropdownMenu
          class="gt-dd gt-dd-scale"
          :options="scaleOptions"
          :model-value="scale"
          @update:model-value="scale = $event as GanttScale"
        />
      </div>
      <p v-if="relationsError" class="gt-warn">{{ t("gantt.depsFailed") }}</p>

      <!-- 空态三档：未选项目 / 无日期字段 / 无条目 -->
      <p v-if="!selectedId" class="gt-empty">{{ t("project.empty") }}</p>
      <p v-else-if="!dateFields.length" class="gt-empty">{{ t("roadmap.noDateField") }}</p>
      <p v-else-if="!nodes.length && !storeLoading" class="gt-empty">{{ t("gantt.noItems") }}</p>

      <!-- 甘特本体（jordium）：视图锁定任务模式。依赖锚点 G3-a 起对容器形态
           开放（草稿/本地 issue；平台引用 toast 说明待 G3-b——《甘特计划面》§4
           写路由）；抽屉与右键菜单仍关（编辑面随 G3-b/c 分级打开，不开假交互）。 -->
      <div v-else class="gt-jordium">
        <GanttChart
          :tasks="jTasks"
          view-mode="task"
          :available-view-modes="['task']"
          :show-toolbar="false"
          :theme="resolvedTheme"
          :locale="locale"
          :time-scale="scale"
          :row-height="40"
          :link-config="linkConfig"
          :task-list-config="taskListConfig"
          :allow-drag-and-resize="true"
          :enable-link-anchor="false"
          :use-default-drawer="false"
          :enable-task-list-context-menu="false"
          :enable-task-bar-context-menu="false"
          :show-conflicts="false"
          :auto-sort-by-start-date="false"
          @taskbar-drag-end="onBarDatesChanged"
          @taskbar-resize-end="onBarDatesChanged"
          @task-collapse-change="onCollapseChange"
        />
      </div>
    </div>
  </PanelShell>
</template>

<style scoped>
.gt {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.gt-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.gt-label {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 右栏动作（PanelShell #actions）：与看板面板的 22px 小按钮同款 */
.gt-refresh {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  border-radius: 5px;
  cursor: pointer;
}
.gt-refresh:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.gt-note {
  font-size: var(--font-sm);
  color: var(--text-dim);
  white-space: nowrap;
}
.gt-flex {
  flex: 1;
}
/* 下拉宽度收齐（触发盒内容自适应会参差）：日期字段 128 / 结束 104 / 刻度 72；
   标签超长省略，chevron 恒贴右缘 */
.gt-dd :deep(.dd-trigger) {
  justify-content: space-between;
}
.gt-dd :deep(.dd-label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gt-dd-start :deep(.dd-trigger) {
  width: 128px;
}
.gt-dd-end :deep(.dd-trigger) {
  width: 104px;
}
.gt-dd-scale :deep(.dd-trigger) {
  width: 72px;
}
.gt-warn {
  margin: 0;
  padding: 4px 10px;
  font-size: var(--font-sm);
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.gt-empty {
  margin: 24px auto;
  font-size: var(--font-base);
  color: var(--text-dim);
}
.gt-jordium {
  flex: 1;
  min-height: 0;
  /* jordium 的画布自己滚，容器只负责给高度 */
  display: flex;
}
.gt-jordium > * {
  flex: 1;
  min-height: 0;
}
</style>

<!-- 主题对齐：jordium 的 --gantt-* 变量族 → 本应用 token。
     非 scoped：变量要走继承覆盖库自身的 :root / [data-theme] 声明，
     故用 .gt-jordium 前缀限域 + 提高一级特异度覆盖库内组件级默认值。 -->
<style>
.gt-jordium,
.gt-jordium .gantt-root[data-theme] {
  /* 底色 */
  --gantt-bg-primary: var(--bg-panel);
  --gantt-bg-secondary: var(--bg-app);
  --gantt-bg-tertiary: var(--bg-app);
  --gantt-bg-light: var(--bg-app);
  --gantt-bg-dark: var(--bg-chip);
  --gantt-bg-darker: var(--bg-hover);
  --gantt-bg-active: var(--bg-selected);
  --gantt-bg-hover: var(--bg-hover);
  --gantt-bg-hover-dark: var(--bg-hover);
  --gantt-bg-hover-parent: var(--bg-hover);
  --gantt-bg-toolbar: var(--bg-panel);
  --gantt-bg-disabled: var(--bg-chip);
  /* 文字 */
  --gantt-text-primary: var(--text);
  --gantt-text-regular: var(--text);
  --gantt-text-secondary: var(--text-dim);
  --gantt-text-tertiary: var(--text-dim);
  --gantt-text-muted: var(--text-dim);
  --gantt-text-header: var(--text);
  --gantt-text-parent: var(--text);
  --gantt-text-placeholder: var(--text-dim);
  --gantt-text-disabled: var(--text-dim);
  --gantt-text-white: #ffffff;
  --gantt-text-on-primary: #ffffff;
  /* 边框 */
  --gantt-border-light: var(--border);
  --gantt-border-color: var(--border);
  --gantt-border-base: var(--border);
  --gantt-border-medium: var(--border);
  --gantt-border-dark: var(--border);
  --gantt-border-hover: var(--text-dim);
  --gantt-border-disabled: var(--border);
  /* 语义色 */
  --gantt-primary: var(--accent);
  --gantt-primary-color: var(--accent);
  --gantt-primary-light: var(--accent-soft);
  --gantt-primary-lightest: var(--accent-soft);
  --gantt-primary-dark: var(--accent);
  --gantt-primary-hover: var(--accent);
  --gantt-success: var(--success);
  --gantt-warning: var(--warning);
  --gantt-warning-light: var(--warning-soft);
  --gantt-danger: var(--danger);
  --gantt-danger-light: var(--danger-soft);
  --gantt-danger-dark: var(--danger);
  --gantt-info: var(--accent);
  --gantt-off-leave: var(--merged);
  --gantt-off-leave-light: var(--merged-soft);
  /* 滚动条 */
  --gantt-scrollbar-thumb: var(--border);
  --gantt-scrollbar-thumb-hover: var(--text-dim);
  /* 度量：字号收进本应用五档；圆角随面板体系 */
  --gantt-font-size-sm: var(--font-sm);
  --gantt-radius-sm: 6px;
}
/* 库内字体的绝对尺寸兜底（沿用 token 而非 13/14px 裸值） */
.gt-jordium {
  font-size: var(--font-md);
}

/* ---- 字号对齐（2026-09-21 用户实测对比 Roadmap 后要求）----
   库内 156 处 font-size 几乎全是硬编码 px、只有 1 处走变量；其中
   `.task-list { font-size: 15px }` 是「整块左栏大一圈」的根源（列头与
   单元格都继承它）。此处按 Roadmap 的既定档位逐类改写：
   月/年标签 = --font-md(12)、日/周标签 = --font-sm(11)、任务名与条内标题
   = --font-base(13)、条内进度/工具条按钮 = --font-md(12)、徽标 = --font-xs(10)。
   选择器用 `.gt-jordium` 前缀（特异性 ≥ 库的 scoped 规则 (0,2,0)，
   且在产物中后于库样式注入；`pnpm build` 后可在 dist CSS 复核顺序）。 */
.gt-jordium .task-list {
  font-size: var(--font-md);
}
.gt-jordium .task-name {
  font-size: var(--font-base);
}
.gt-jordium .expanded-title {
  font-size: var(--font-base);
}
.gt-jordium .task-bar-content,
.gt-jordium .task-title-above,
.gt-jordium .actual-task-name {
  font-size: var(--font-md);
}
.gt-jordium .task-progress,
.gt-jordium .actual-bar-content {
  font-size: var(--font-sm);
}
/* 库内有 3 条高特异性规则（.task-bar.overflow-effect …）会压过上面对条内
   文字的覆盖——按同特异性后写胜出补齐，条内字号也走 token。 */
.gt-jordium .task-bar.overflow-effect .task-bar-content,
.gt-jordium .task-bar.overflow-effect .task-name {
  font-size: var(--font-md);
}
.gt-jordium .task-bar.overflow-effect .task-progress {
  font-size: var(--font-sm);
}
/* 时间轴表头刻度 */
.gt-jordium .year-month-label,
.gt-jordium .month-label,
.gt-jordium .quarter-label,
.gt-jordium .half-year-label,
.gt-jordium .date-label,
.gt-jordium .year-label {
  font-size: var(--font-md);
}
.gt-jordium .day-label,
.gt-jordium .week-label,
.gt-jordium .hour-label {
  font-size: var(--font-sm);
}
.gt-jordium .milestone-label,
.gt-jordium .predecessor-tag {
  font-size: var(--font-sm);
}
/* 工具条与按钮（本面板关了库工具条，保底对齐） */
.gt-jordium .gantt-btn,
.gt-jordium .gantt-btn-group-item,
.gt-jordium .status-badge,
.gt-jordium .timer-badge {
  font-size: var(--font-md);
}
.gt-jordium .status-badge,
.gt-jordium .timer-badge {
  font-size: var(--font-xs);
}
.gt-jordium .avatar,
.gt-jordium .resource-avatar {
  font-size: var(--font-xs);
}
.gt-jordium .avatar .avatar-text {
  font-size: var(--font-xs);
}
/* 悬浮/拖拽提示与空态 */
.gt-jordium .tooltip-title,
.gt-jordium .hover-tooltip-title {
  font-size: var(--font-base);
}
.gt-jordium .hover-tooltip-label,
.gt-jordium .hover-tooltip-overflow-warning {
  font-size: var(--font-sm);
}
.gt-jordium .task-tooltip,
.gt-jordium .drag-tooltip,
.gt-jordium .drag-preview-content,
.gt-jordium .task-hover-tooltip,
.gt-jordium .anchor-tooltip,
.gt-jordium .milestone-sticky-tooltip {
  font-size: var(--font-md);
}
.gt-jordium .placeholder-text {
  font-size: var(--font-base);
}
.gt-jordium .placeholder-desc {
  font-size: var(--font-md);
}
/* 冲突/超载徽标（本面板关了冲突显示，保底） */
.gt-jordium .conflict-header,
.gt-jordium .conflict-title,
.gt-jordium .total-overload,
.gt-jordium .conflict-task-name,
.gt-jordium .conflict-detail {
  font-size: var(--font-sm);
}

/* ---- 深色模式与形态对齐（2026-09-21 用户实机对比）----
   库的任务条配色是**运行时内联计算**的：状态色再混 95%/70% 白生成底色/边框
   （源码实证 `Math.round(255*0.95 + c*0.05)`），公式硬编码白底假设——深色画布
   上必然呈现粉白块。状态色同样内联写死，无类名可分（只有 completed/parent-task
   两个状态类），故只能以 !important 覆盖，且只在深色下生效（浅色下库的淡彩可读）。
   本仓库对内嵌组件用 !important 是既有手法（KnowledgeTree/TableEditor 等 8 处先例）。 */
:root[data-theme="dark"] .gt-jordium .task-bar {
  background-color: var(--bg-panel) !important;
  border-color: var(--border) !important;
  color: var(--text) !important;
}
:root[data-theme="dark"] .gt-jordium .task-bar.completed {
  background-color: var(--success-soft) !important;
  border-color: var(--success) !important;
}
:root[data-theme="dark"] .gt-jordium .task-bar.parent-task {
  background-color: var(--bg-chip) !important;
  border-color: var(--text-dim) !important;
}
/* 条太窄时库把标题甩出条外（overflow-effect），且沿用状态色（一律红）——
   深色下满屏浮红字很跳。收到次级文本色：与左侧列表同名信息形成"二次提及"
   而非告警（逾期语义由列表里的逾期徽标承担）。 */
.gt-jordium .task-bar.overflow-effect .task-name,
.gt-jordium .task-bar.overflow-effect .task-progress {
  color: var(--text-dim);
}
/* 左侧列表表头：应用口径 = 600 字重 + 次级色 + 名称列左对齐
   （库是 700 加粗 + 居中 + 头部 80px 用于与时间轴表头对齐，高度保留） */
.gt-jordium .task-list-header,
.gt-jordium .task-list-header .col {
  font-weight: 600;
}
.gt-jordium .task-list-header .col {
  color: var(--text-dim);
}
.gt-jordium .task-list-header .col-name,
.gt-jordium .task-list-header .col-taskName {
  justify-content: flex-start;
}
/* 今日：库给整列铺主色（蓝）半透明 + 表头日号实心蓝块；应用口径（Roadmap）
   是「一条淡红今日线」。整列铺色改为淡红，表头日号保留实心块做定位锚。 */
.gt-jordium .day-column.today {
  background-color: color-mix(in srgb, var(--danger) 22%, transparent);
  opacity: 1;
  border-left-color: color-mix(in srgb, var(--danger) 45%, transparent);
}
.gt-jordium .day-column.today:before {
  background: none;
}
</style>
