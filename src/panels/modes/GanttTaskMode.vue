<script setup lang="ts">
/**
 * 甘特 · 任务 Mode（排程主视图）——共享状态见 `gantt-state.ts`；本组件只负责
 * 渲染（GanttChart viewMode=task）+ 交互事件转发到共享写路由。
 */
import { ref, watch } from "vue";
import { GanttChart, TaskListContextMenu, type Task as JTask } from "jordium-gantt-vue3";
import { useGanttState } from "../gantt-state";
import { useI18n } from "../../i18n";
import { useTheme } from "../../theme";
import EditorIcon from "../../components/EditorIcon.vue";
import { computeRipple, type GanttNode } from "../gantt-model";
import { pushToast } from "../../toast";

const props = defineProps<{
  /** 刻度与违规行样式等由宿主面板下传（工具条在宿主）。 */
  scale: "hour" | "day" | "week" | "month" | "quarter" | "year";
  openEditor: (nodeId: string) => void;
  removeItem: (nodeId: string) => void;
}>();
const emit = defineEmits<{ "rows-changed": [] }>();

const g = useGanttState();
const { t } = useI18n();
const { resolvedTheme } = useTheme();
const { locale } = useI18n();

/** 折叠态跨重建保留。 */
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

/** 违规行类名（G4-a：后继开始早于前驱结束）。 */
function rowClassName(row: JTask): string {
  const nodeId = g.nodeIdOf.value.get(row.id);
  const node = nodeId ? g.nodeById.value.get(nodeId) : undefined;
  return node && node.violations.length > 0 ? "gt-violation" : "";
}

function toJordiumTasks(flat: GanttNode[]): JTask[] {
  const ids = g.idOf.value;
  const roots: JTask[] = [];
  const stack: JTask[] = [];
  for (const n of flat) {
    const jid = ids.get(n.id);
    if (!jid) continue;
    const violated = n.violations.length > 0;
    const task: JTask = {
      id: jid,
      name: n.title,
      startDate: n.start ?? undefined,
      endDate: n.end ?? undefined,
      progress: n.progress ?? 0,
      predecessor: n.dependsOn.map((d) => ids.get(d) ?? 0).filter((d) => d > 0),
      assignee: n.assignees.length ? n.assignees.join(", ") : undefined,
      actualStartDate: n.actualStart ?? undefined,
      actualEndDate: n.actualEnd ?? undefined,
      estimatedHours: n.estimatedHours ?? undefined,
      actualHours: n.actualHours ?? undefined,
      barColor: violated ? "var(--danger)" : undefined,
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

const jTasks = ref<JTask[]>([]);
watch(
  g.nodes,
  (flat) => {
    jTasks.value = toJordiumTasks(flat);
    emit("rows-changed");
  },
  { immediate: true },
);

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
    { key: "estimatedHours", type: "estimatedHours" as const, width: 88 },
    { key: "actualHours", type: "actualHours" as const, width: 88 },
  ],
  defaultWidth: 380,
  minWidth: 280,
};

function unwrapTask(payload: { task?: JTask } | JTask): JTask | null {
  const t0 = (payload as { task?: JTask }).task ?? (payload as JTask);
  return t0 && typeof (t0 as JTask).id === "number" ? (t0 as JTask) : null;
}

/** 拖拽/改宽 → 计划起止写字段（与编辑面板同通道）；写完后按依赖算**涟漪**，
 *  影响面 > 0 时弹带动作的提示（一键顺延，G4-b 调度语义第二步）。 */
async function onBarDatesChanged(task: JTask) {
  const nodeId = g.nodeIdOf.value.get(task.id);
  const node = nodeId ? g.nodeById.value.get(nodeId) : undefined;
  if (!nodeId || !node) return;
  const isoDay = (v?: string | null) => (/^(\d{4}-\d{2}-\d{2})/.exec(v ?? "")?.[1] ?? null);
  try {
    const newStart = isoDay(task.startDate);
    const newEnd = isoDay(task.endDate);
    if (g.startField.value && newStart && newStart !== node.start) {
      await g.setFieldValue(nodeId, g.startField.value.id, newStart);
    }
    if (g.endField.value && newEnd && newEnd !== node.end) {
      await g.setFieldValue(nodeId, g.endField.value.id, newEnd);
    }
    // 涟漪提示：后继里有多少条现在「开工早于前驱完工」
    const ripple = computeRipple(g.nodes.value, {
      id: nodeId,
      start: newStart ?? node.start,
      end: newEnd ?? node.end,
    });
    if (ripple.length) {
      pushToast(
        {
          kind: "info",
          message: t("gantt.rippleHint", { n: String(ripple.length) }),
          action: {
            label: t("gantt.rippleApply"),
            run: () => {
              void g
                .applyRipple(ripple)
                .then(() => pushToast({ kind: "success", message: t("gantt.rippleApplied", { n: String(ripple.length) }) }))
                .catch((e) => g.reportError(e));
            },
          },
        },
        15000,
      );
    }
  } catch (e) {
    g.reportError(e);
  }
}

/** 锚点连线（容器/平台分流 + 环检测）。 */
async function onDepLink(payload: { targetTask?: JTask; newTask?: JTask }) {
  const targetId = payload.targetTask?.id != null ? g.nodeIdOf.value.get(payload.targetTask.id) : undefined;
  const newId = payload.newTask?.id != null ? g.nodeIdOf.value.get(payload.newTask.id) : undefined;
  if (!targetId || !newId) return;
  const rollback = () => {
    jTasks.value = toJordiumTasks(g.nodes.value);
  };
  if (g.wouldCreateCycle(g.graphDeps.value, targetId, newId)) {
    g.reportError(new Error(t("gantt.depCycle")));
    rollback();
    return;
  }
  const ctx = g.platformWriteCtx(targetId, newId);
  try {
    if (ctx) {
      await g.addEdge(targetId, newId);
      await g.loadRelations(true);
    } else if (!g.isContainerForm(targetId) && !g.isContainerForm(newId)) {
      g.reportError(new Error(t("gantt.depPlatformUnsupported")));
      rollback();
    } else {
      await g.addEdge(targetId, newId);
    }
  } catch (e) {
    g.reportError(e);
    rollback();
  }
}

async function onDepUnlink(payload: { sourceTaskId?: number; targetTaskId?: number }) {
  const sourceId = payload.sourceTaskId != null ? g.nodeIdOf.value.get(payload.sourceTaskId) : undefined;
  const targetId = payload.targetTaskId != null ? g.nodeIdOf.value.get(payload.targetTaskId) : undefined;
  if (!sourceId || !targetId) return;
  try {
    await g.removeEdge(targetId, sourceId);
    await g.loadRelations(true);
  } catch (e) {
    g.reportError(e);
    jTasks.value = toJordiumTasks(g.nodes.value);
  }
}

/** 库的 task-updated：编辑走应用风格编辑面板，这里只留依赖同步。 */
async function onTaskUpdated(payload: { task?: JTask } | JTask) {
  const task = unwrapTask(payload);
  if (!task) return;
  const nodeId = g.nodeIdOf.value.get(task.id);
  if (!nodeId) return;
  try {
    await g.syncPredecessors(nodeId, task.predecessor ?? []);
  } catch (e) {
    g.reportError(e);
  }
}

function onTaskDoubleClick(payload: JTask | { task?: JTask }) {
  const task = unwrapTask(payload);
  const nodeId = task ? g.nodeIdOf.value.get(task.id) : undefined;
  if (nodeId) props.openEditor(nodeId);
}

function onRowMenuEdit(row: JTask) {
  const nodeId = row?.id != null ? g.nodeIdOf.value.get(row.id) : undefined;
  if (nodeId) props.openEditor(nodeId);
}

function onRowMenuRemove(row: JTask) {
  const nodeId = row?.id != null ? g.nodeIdOf.value.get(row.id) : undefined;
  if (nodeId) props.removeItem(nodeId);
}

</script>

<template>
  <div class="gt-jordium">
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
      :task-list-row-class-name="rowClassName"
      :allow-drag-and-resize="true"
      :enable-link-anchor="true"
      :use-default-drawer="false"
      :enable-task-list-context-menu="true"
      :enable-task-bar-context-menu="false"
      :show-conflicts="true"
      :auto-sort-by-start-date="false"
      :show-actual-taskbar="true"
      @task-double-click="onTaskDoubleClick"
      @taskbar-drag-end="onBarDatesChanged"
      @taskbar-resize-end="onBarDatesChanged"
      @task-collapse-change="onCollapseChange"
      @predecessor-added="onDepLink"
      @successor-added="onDepLink"
      @link-deleted="onDepUnlink"
      @task-updated="onTaskUpdated"
    >
      <TaskListContextMenu>
        <template #default="{ row }">
          <div class="gt-menu-item" @click="onRowMenuEdit(row)">
            <EditorIcon name="pencil" />
            <span>{{ t("project.actEdit") }}</span>
          </div>
          <div class="gt-menu-item" @click="onRowMenuRemove(row)">
            <EditorIcon name="o.trash" />
            <span>{{ t("gantt.removeItem") }}</span>
          </div>
        </template>
      </TaskListContextMenu>
    </GanttChart>
  </div>
</template>

<style scoped>
.gt-jordium {
  flex: 1;
  min-height: 0;
  display: flex;
}
.gt-jordium > * {
  flex: 1;
  min-height: 0;
}
.gt-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: var(--font-md);
  color: var(--text);
  cursor: pointer;
  border-radius: 4px;
}
.gt-menu-item:hover {
  background: var(--bg-hover);
}
</style>
