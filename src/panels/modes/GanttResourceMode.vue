<script setup lang="ts">
/**
 * 甘特 · 资源 Mode（按资源泳道）——同一批条目的另一种编队（《甘特计划面》§5-bis）。
 * 库原生 `viewMode="resource"`：把资源目录 + 分配喂给 GanttChart 的 `resources`。
 */
import { computed, ref, watch } from "vue";
import { GanttChart, type Resource as JResource, type Task as JTask } from "jordium-gantt-vue3";
import { useGanttState } from "../gantt-state";
import { useTheme } from "../../theme";
import { useI18n } from "../../i18n";

const props = defineProps<{
  scale: "hour" | "day" | "week" | "month" | "quarter" | "year";
  openEditor: (nodeId: string) => void;
}>();
void props;

const g = useGanttState();
const { resolvedTheme } = useTheme();
const { locale } = useI18n();

/** 共享的 jordium 任务树（与任务 Mode 同源：flat → 嵌套）。 */
const jTasks = computed<JTask[]>(() => {
  const ids = g.idOf.value;
  const roots: JTask[] = [];
  const stack: JTask[] = [];
  for (const n of g.nodes.value) {
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
    };
    stack.length = n.depth;
    if (n.depth === 0 || !stack[n.depth - 1]) roots.push(task);
    else {
      const parent = stack[n.depth - 1];
      parent.children = parent.children ?? [];
      parent.children.push(task);
      task.parentId = parent.id;
    }
    stack.push(task);
  }
  return roots;
});

/** 资源目录 → 库的 Resource（每资源挂上分配给它的任务；capacity = 占用比例，照库口径）。 */
const jResources = computed<JResource[]>(() =>
  g.resourceCatalog.value.map((r) => {
    const ids = g.idOf.value;
    const assigned: JTask[] = [];
    for (const [itemId, rows] of Object.entries(g.itemResources.value)) {
      const row = rows.find((x) => x.resourceId === r.id);
      const jid = ids.get(itemId);
      const node = g.nodeById.value.get(itemId);
      if (!row || !jid || !node) continue;
      assigned.push({
        id: jid,
        name: node.title,
        startDate: node.start ?? undefined,
        endDate: node.end ?? undefined,
        progress: node.progress ?? 0,
        capacity: row.allocation, // 库语义：资源在任务内的占用比例
        tasks: [],
      });
    }
    return {
      id: r.id,
      name: r.name,
      title: r.title ?? undefined,
      type: r.type,
      department: r.department ?? undefined,
      capacity: r.capacity ?? undefined,
      color: r.color ?? undefined,
      tasks: assigned,
    };
  }),
);

const linkConfig = { type: "orthogonal" as const, style: "solid" as const, width: 1.2 };
const resourceListConfig = {
  columns: [
    { key: "name", type: "name" as const, width: 200 },
    { key: "title", type: "title" as const, width: 140 },
  ],
  defaultWidth: 360,
};

const jTasksRef = ref<JTask[]>([]);
watch(jTasks, (v) => (jTasksRef.value = v), { immediate: true });
</script>

<template>
  <div class="gt-jordium">
    <GanttChart
      :tasks="jTasksRef"
      :resources="jResources"
      view-mode="resource"
      :available-view-modes="['resource']"
      :show-toolbar="false"
      :theme="resolvedTheme"
      :locale="locale"
      :time-scale="scale"
      :row-height="40"
      :link-config="linkConfig"
      :resource-list-config="resourceListConfig"
      :allow-drag-and-resize="true"
      :enable-link-anchor="false"
      :use-default-drawer="false"
      :enable-task-list-context-menu="false"
      :enable-task-bar-context-menu="false"
      :auto-sort-by-start-date="false"
      @task-double-click="(task: JTask) => props.openEditor(g.nodeIdOf.value.get(task.id) ?? '')"
    />
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
</style>
