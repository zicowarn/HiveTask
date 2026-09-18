<script setup lang="ts">
/**
 * 日历面板（工具类目）——FullCalendar v6（锁 6.1.21）月/列表视图。
 *
 * 语义定案（设计讨论 2026-09-17）：日历 = **投影图层**，自身不存任何数据、
 * 不做第二个日期真源。四个图层全部来自已有缓存：
 *   里程碑截止（issues store 每仓库缓存）/ Issue·PR 创建（仓库缓存 SQLite）/
 *   项目日期字段（app.db，projects store 当前已加载项目）。
 * 「提交热力」与 ICS 订阅（Google/Outlook/节假日）与农历是后续图层，见 TASK.md 台账。
 *
 * WKWebView 结论：@fullcalendar/* 6.1.21 + preact 全部 dist 经 AGENTS.md 规定
 * 的 Iterator/withResolvers 等六项扫描零命中；样式由包内 JS 注入，无 CSS 入口。
 * 点击事件 = 在浏览器打开（与「在 GitHub 打开」同源）；本地无 url 的事件不跳。
 */
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import FullCalendar from "@fullcalendar/vue3";
import dayGridPlugin from "@fullcalendar/daygrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import type { CalendarOptions, EventClickArg } from "@fullcalendar/core";
import PanelShell from "../workbench/PanelShell.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useRepoStore } from "../stores/repo";
import { useIssuesStore } from "../stores/issues";
import { usePullsStore } from "../stores/pulls";
import { useProjectsStore } from "../stores/projects";
import { useI18n } from "../i18n";
import { isTauri } from "../api";
import { openExternalUrl } from "../open-url";
import { buildCalendarEvents, type CalendarEventKind } from "./calendar-events";

defineProps<{ leafId?: string; panelType?: string }>();

const repo = useRepoStore();
const { current } = storeToRefs(repo);
const issues = useIssuesStore();
const pulls = usePullsStore();
const projects = useProjectsStore();
const { t, locale } = useI18n();

/** 图层开关（DropdownMenu multiple：保持展开连续勾选）。 */
const LAYERS: CalendarEventKind[] = ["milestone", "issue", "pull", "project"];
const visibleLayers = ref<string[]>([...LAYERS]);

const layerOptions = computed(() => [
  { value: "milestone", label: t("calendar.layer.milestones") },
  { value: "issue", label: t("calendar.layer.issues") },
  { value: "pull", label: t("calendar.layer.pulls") },
  { value: "project", label: t("calendar.layer.projects") },
]);

/** 四图层聚合 → FullCalendar 事件（kind 挂 classNames 上色）。 */
const calendarEvents = computed(() => {
  const all = buildCalendarEvents({
    milestones: issues.milestones,
    issues: issues.issues,
    pulls: pulls.pulls,
    projectFields: projects.fields,
    projectItems: projects.items,
  });
  return all
    .filter((e) => visibleLayers.value.includes(e.kind))
    .map((e) => ({
      id: e.id,
      title: e.title,
      start: e.date,
      extendedProps: { url: e.url },
      classNames: [`ev-${e.kind}`],
    }));
});

function onEventClick(info: EventClickArg): void {
  const url = info.event.extendedProps?.url as string | undefined;
  if (url) openExternalUrl(url);
  // 本地 Issue / 项目日期无线上页：不跳（诚实无操作，不弹误导性反馈）
}

const options = computed<CalendarOptions>(() => ({
  plugins: [dayGridPlugin, listPlugin, interactionPlugin],
  initialView: "dayGridMonth",
  headerToolbar: { left: "prev,next today", center: "title", right: "dayGridMonth,listWeek" },
  locale: locale.value === "zh-CN" ? zhCnLocale : undefined,
  height: "100%",
  firstDay: 1,
  dayMaxEvents: true,
  events: calendarEvents.value,
  eventClick: onEventClick,
}));

/** 仓库切换 → 重灌三个图层的缓存（里程碑沿用每仓库缓存，远端仅首访拉取）。 */
watch(
  current,
  (path) => {
    if (!path || !isTauri()) return;
    void issues.loadCache().catch(() => {});
    void pulls.loadCache().catch(() => {});
    void issues.loadMilestones(path).catch(() => {});
    // 项目图层吃 projects store 当前已加载的项目；未打开过项目工作区则补一次
    if (projects.items.length === 0 && projects.fields.length === 0) {
      void projects.loadAll().catch(() => {});
    }
  },
  { immediate: true },
);
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template #actions>
      <DropdownMenu v-model="visibleLayers" multiple :options="layerOptions">
        <template #trigger="{ open, toggle }">
          <button class="layer-btn" :class="{ open }" type="button" @click="toggle">
            <EditorIcon name="o.calendar" />
            <span>{{ t("calendar.layers") }}</span>
          </button>
        </template>
      </DropdownMenu>
    </template>
    <div class="calendar-wrap">
      <p v-if="!current" class="cal-hint">{{ t("calendar.noRepo") }}</p>
      <FullCalendar v-else :options="options" />
    </div>
  </PanelShell>
</template>

<style scoped>
.layer-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  line-height: 1;
  padding: 0 7px;
  cursor: pointer;
  outline: none;
}
.layer-btn:hover,
.layer-btn.open {
  border-color: var(--accent);
  color: var(--accent);
}

.calendar-wrap {
  height: 100%;
  min-height: 0;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
}
.cal-hint {
  font-size: var(--font-md);
  color: var(--text-dim);
  padding: 12px 2px;
}

/* FullCalendar → 项目 token 映射（fc 变量 + 关键件覆写；包内自带样式为 JS 注入）。 */
.calendar-wrap :deep(.fc) {
  --fc-page-bg-color: transparent;
  --fc-border-color: var(--border);
  --fc-today-bg-color: var(--bg-hover);
  --fc-neutral-bg-color: var(--bg-app);
  --fc-event-border-color: transparent;
  color: var(--text);
  font-size: var(--font-md);
  flex: 1;
  min-height: 0;
}
.calendar-wrap :deep(.fc .fc-toolbar-title) {
  font-size: var(--font-base);
  font-weight: 600;
}
.calendar-wrap :deep(.fc .fc-button) {
  height: 22px;
  padding: 0 7px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: var(--font-md);
  font-weight: 400;
  text-transform: none;
  box-shadow: none;
}
.calendar-wrap :deep(.fc .fc-button:hover) {
  background: var(--bg-app);
  border-color: var(--accent);
  color: var(--accent);
}
.calendar-wrap :deep(.fc .fc-button-primary:not(:disabled).fc-button-active) {
  background: var(--bg-selected);
  border-color: var(--accent);
  color: var(--accent);
}
.calendar-wrap :deep(.fc .fc-button:disabled) {
  background: var(--bg-app);
  border-color: var(--border);
  color: var(--text-dim);
}
.calendar-wrap :deep(.fc .fc-col-header-cell-cushion),
.calendar-wrap :deep(.fc .fc-daygrid-day-number),
.calendar-wrap :deep(.fc .fc-list-day-text),
.calendar-wrap :deep(.fc .fc-list-day-side-text) {
  color: var(--text);
  font-size: var(--font-md);
  text-decoration: none;
}
.calendar-wrap :deep(.fc .fc-list-event-title) {
  color: var(--text);
  font-size: var(--font-md);
}
.calendar-wrap :deep(.fc .fc-list-event-dot) {
  border-color: var(--accent);
}
.calendar-wrap :deep(.fc-event) {
  cursor: default;
  font-size: var(--font-xs);
  line-height: 1.3;
}
.calendar-wrap :deep(.fc-event.ev-milestone) {
  background: var(--accent);
}
.calendar-wrap :deep(.fc-event.ev-issue) {
  background: var(--success);
}
.calendar-wrap :deep(.fc-event.ev-pull) {
  background: var(--merged);
}
/* 项目日期字段：中性灰（非平台状态色，避免误导为远端实体） */
.calendar-wrap :deep(.fc-event.ev-project) {
  background: var(--bg-selected);
  border: 1px solid var(--border);
  color: var(--text);
}
.calendar-wrap :deep(.fc-event.ev-project .fc-event-title) {
  color: var(--text);
}
</style>
