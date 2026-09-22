<script setup lang="ts">
/**
 * 甘特 · 负载 Mode（资源工时负载）——《甘特计划面》§5-bis R3。
 * 库原生 `viewMode="resource-usage"`：按日/周/月桶聚合每资源的总占比，
 * 超载（>100%）/欠载按阈值配色；资源级例外（请假/停机）来自我们的资源日历表。
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

const jTasks = computed<JTask[]>(() => {
  const ids = g.idOf.value;
  return g.nodes.value
    .map((n) => ({
      id: ids.get(n.id) ?? 0,
      name: n.title,
      startDate: n.start ?? undefined,
      endDate: n.end ?? undefined,
      progress: n.progress ?? 0,
      children: [],
    }))
    .filter((x) => x.id > 0);
});

/** 资源（含分配给它的任务与占比）——负载视图按此聚合。 */
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
        capacity: row.allocation,
        tasks: [],
      });
    }
    return {
      id: r.id,
      name: r.name,
      title: r.title ?? undefined,
      type: r.type,
      capacity: r.capacity ?? undefined,
      color: r.color ?? undefined,
      tasks: assigned,
    };
  }),
);

/** 负载视图参数：超载阈值 100%（照库语义 totalPercent > threshold）、欠载 50%、
 *  显示资源请假/停机样式（来自资源级例外）。 */
const usageProps = {
  overloadThreshold: 100,
  underloadThreshold: 50,
  showResourceOffOrLeaveStyle: true,
};

const jTasksRef = ref<JTask[]>([]);
watch(jTasks, (v) => (jTasksRef.value = v), { immediate: true });
</script>

<template>
  <div class="gt-jordium">
    <GanttChart
      :tasks="jTasksRef"
      :resources="jResources"
      view-mode="resource-usage"
      :available-view-modes="['resource-usage']"
      :show-toolbar="false"
      :theme="resolvedTheme"
      :locale="locale"
      :time-scale="scale"
      :row-height="40"
      :resource-usage-props="usageProps"
      :enable-task-list-context-menu="false"
      :enable-task-bar-context-menu="false"
      :use-default-drawer="false"
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
