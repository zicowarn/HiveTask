<script setup lang="ts">
/**
 * 日历面板（工具类目）——FullCalendar v6（锁 6.1.21）月/列表视图。
 *
 * 图层模型（设计定案：日历 = 投影，不存数据、不做第二个日期真源）：
 *  - 投影：里程碑截止 / Issue·PR 创建 / 项目日期字段（读既有缓存，零存储）；
 *  - 提交热力：git_commit_activity 日格角标（装饰常显，不进图层菜单）；
 *  - 法定假日：内置 holiday-cn JSON（休=红 / 班=灰，随版本兜底，零网络）；
 *  - ICS 订阅：calendar_feeds（app_008），断网读缓存，URL 不进日志；管理入口在设置面板（来源连接同款模式）
 *  - 农历副行：chinese-lunisolar-calendar（Rust 侧算法），初一显月名。
 *
 * WKWebView 结论：@fullcalendar/* 6.1.21 + preact 六项扫描零命中（THIRD-PARTY.md）。
 */
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import FullCalendar from "@fullcalendar/vue3";
import dayGridPlugin from "@fullcalendar/daygrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import type { CalendarOptions, DatesSetArg, DayCellMountArg, EventClickArg } from "@fullcalendar/core";
import PanelShell from "../workbench/PanelShell.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useRepoStore } from "../stores/repo";
import { useIssuesStore } from "../stores/issues";
import { usePullsStore } from "../stores/pulls";
import { useProjectsStore } from "../stores/projects";
import { useI18n } from "../i18n";
import { api, isTauri } from "../api";
import type { CalendarFeed, CalendarFeedEvent, HolidayDay } from "../api";
import { openExternalUrl } from "../open-url";
import { buildCalendarEvents, dateKey, heatBucket, type CalendarEventKind } from "./calendar-events";

defineProps<{ leafId?: string; panelType?: string }>();

const repo = useRepoStore();
const { current } = storeToRefs(repo);
const issues = useIssuesStore();
const pulls = usePullsStore();
const projects = useProjectsStore();
const { t, locale } = useI18n();

// ---- 图层开关（DropdownMenu multiple：保持展开连续勾选） ----

const PROJECTION_LAYERS: CalendarEventKind[] = ["milestone", "issue", "pull", "project"];
const visibleLayers = ref<string[]>([...PROJECTION_LAYERS, "holiday"]);

const layerOptions = computed(() => [
  { value: "milestone", label: t("calendar.layer.milestones") },
  { value: "issue", label: t("calendar.layer.issues") },
  { value: "pull", label: t("calendar.layer.pulls") },
  { value: "project", label: t("calendar.layer.projects") },
  { value: "holiday", label: t("calendar.layer.holidays") },
  ...feeds.value.map((f) => ({ value: `feed:${f.id}`, label: f.name })),
]);

// ---- 订阅 / 假日（应用级，不随仓库切换） ----

const feeds = ref<CalendarFeed[]>([]);
const feedEvents = ref<CalendarFeedEvent[]>([]);
const holidayDays = ref<HolidayDay[]>([]);
let appLoaded = false;
let autoSyncStarted = false;
/** 订阅过期阈值：超 6 小时在面板打开时后台重拉（离线诚实跳过）。 */
const STALE_MS = 6 * 3600 * 1000;

function reconcileLayers(): void {
  const feedIds = feeds.value.map((f) => `feed:${f.id}`);
  const kept = visibleLayers.value.filter((v) => !v.startsWith("feed:"));
  visibleLayers.value = [...kept, ...feedIds];
}

async function refreshFeeds(): Promise<void> {
  if (!isTauri()) return;
  try {
    [feeds.value, feedEvents.value] = await Promise.all([
      api.calendarFeedList(),
      api.calendarFeedEvents(),
    ]);
    reconcileLayers();
  } catch {
    // 命令不可达（浏览器预览）：诚实无订阅图层
  }
}

function lastSyncMs(s: string): number {
  const v = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(v) ? 0 : v;
}

async function autoSyncStale(): Promise<void> {
  if (autoSyncStarted) return;
  autoSyncStarted = true;
  let touched = false;
  for (const feed of feeds.value) {
    if (!feed.enabled) continue;
    const stale = !feed.lastSyncedAt || Date.now() - lastSyncMs(feed.lastSyncedAt) > STALE_MS;
    if (!stale) continue;
    try {
      await api.calendarFeedSync(feed.id);
      touched = true;
    } catch {
      // 断网/失败：读缓存（错误信息不含 URL，后端红线）
    }
  }
  if (touched) await refreshFeeds();
}

async function ensureAppData(): Promise<void> {
  if (appLoaded || !isTauri()) return;
  appLoaded = true;
  await refreshFeeds();
  try {
    holidayDays.value = await api.calendarHolidays();
  } catch {
    holidayDays.value = [];
  }
  void autoSyncStale();
}

// ---- 农历副行（应用级；预取今天 ±370 天，超出再补拉） ----

const lunarMap = ref<Map<string, string>>(new Map());
let lunarCoverFrom: string | null = null;
let lunarCoverTo: string | null = null;

async function ensureLunar(from: Date, to: Date): Promise<void> {
  if (!isTauri()) return;
  const fromK = dateKey(from);
  const toK = dateKey(to);
  if (lunarCoverFrom && lunarCoverTo && fromK >= lunarCoverFrom && toK <= lunarCoverTo) return;
  const fetchFrom = dateKey(new Date(from.getTime() - 30 * 86400e3));
  const fetchTo = dateKey(new Date(to.getTime() + 30 * 86400e3));
  try {
    const rows = await api.calendarLunarRange(fetchFrom, fetchTo);
    const next = new Map(lunarMap.value);
    for (const row of rows) next.set(row.date, row.text);
    lunarMap.value = next;
    lunarCoverFrom = fetchFrom;
    lunarCoverTo = fetchTo;
    calKey.value += 1; // 重挂载让已挂载的日格补上副行
  } catch {
    // 超出支持范围（1901–2101）等：诚实无副行
  }
}

// ---- 提交热力（仓库级） ----

/** 提交热力（日格角标）——刻意不进图层菜单：装饰语义，非事件层。 */
const commitCounts = ref<Map<string, number>>(new Map());
/** 数据到达/切换时 bump：强制 FullCalendar 重挂载，重跑 dayCellDidMount。 */
const calKey = ref(0);

// ---- 事件装配 ----

interface FcEvent {
  id: string;
  title: string;
  start: string;
  extendedProps: { url: string | null };
  classNames: string[];
}

const calendarEvents = computed<FcEvent[]>(() => {
  const projections: FcEvent[] = buildCalendarEvents({
    milestones: issues.milestones,
    issues: issues.issues,
    pulls: pulls.pulls,
    projectFields: projects.fields,
    projectItems: projects.items,
  })
    .filter((e) => visibleLayers.value.includes(e.kind))
    .map((e) => ({
      id: e.id,
      title: e.title,
      start: e.date,
      extendedProps: { url: e.url },
      classNames: [`ev-${e.kind}`],
    }));

  const extras: FcEvent[] = [];
  if (visibleLayers.value.includes("holiday")) {
    for (const h of holidayDays.value) {
      extras.push({
        id: `holiday:${h.date}:${h.name}`,
        title: h.isOffDay ? h.name : `${h.name} ${t("calendar.workdaySuffix")}`,
        start: h.date,
        extendedProps: { url: null },
        classNames: [h.isOffDay ? "ev-holiday" : "ev-workday"],
      });
    }
  }
  for (const f of feedEvents.value) {
    if (visibleLayers.value.includes(`feed:${f.feedId}`)) {
      extras.push({
        id: `feed:${f.feedId}:${f.date}:${f.title}`,
        title: f.title,
        start: f.date,
        extendedProps: { url: null },
        classNames: ["ev-feed"],
      });
    }
  }
  return [...projections, ...extras];
});

function onEventClick(info: EventClickArg): void {
  const url = info.event.extendedProps?.url as string | undefined;
  if (url) openExternalUrl(url);
  // 本地 Issue / 项目日期 / 假日 / 订阅无线上页：诚实不跳
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
  datesSet: (arg: DatesSetArg) => {
    void ensureLunar(arg.start, arg.end);
  },
  // 日格挂载：提交热力 data-heat(-level)（::after 渲染）+ 农历副行（追加 span）
  dayCellDidMount: (arg: DayCellMountArg) => {
    const n = commitCounts.value.get(dateKey(arg.date));
    if (n) {
      arg.el.setAttribute("data-heat", String(n));
      arg.el.setAttribute("data-heat-level", String(heatBucket(n)));
      arg.el.setAttribute("title", t("calendar.heatTooltip", { n }));
    }
    const lunarText = lunarMap.value.get(dateKey(arg.date));
    if (lunarText) {
      const el = document.createElement("span");
      el.className = "cal-lunar";
      el.textContent = lunarText;
      arg.el.appendChild(el);
    }
  },
}));

// ---- 仓库切换 → 重灌投影图层缓存（里程碑沿用每仓库缓存） ----

watch(
  current,
  (path) => {
    if (!path || !isTauri()) return;
    void issues.loadCache().catch(() => {});
    void pulls.loadCache().catch(() => {});
    void issues.loadMilestones(path).catch(() => {});
    if (projects.items.length === 0 && projects.fields.length === 0) {
      void projects.loadAll().catch(() => {});
    }
    api
      .gitCommitActivity(path, 366)
      .then((rows) => {
        commitCounts.value = new Map(rows.map((r) => [r.date, r.count]));
        calKey.value += 1;
      })
      .catch(() => {});
  },
  { immediate: true },
);

onMounted(() => {
  void ensureAppData();
  const now = new Date();
  void ensureLunar(new Date(now.getTime() - 370 * 86400e3), new Date(now.getTime() + 370 * 86400e3));
});
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
      <FullCalendar v-else :key="calKey" :options="options" />
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

/* FullCalendar → 项目 token 映射（包内样式为 JS 注入）。 */
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
/* 法定假日：休=红 / 班=灰（ holiday-cn isOffDay 语义） */
.calendar-wrap :deep(.fc-event.ev-holiday) {
  background: var(--danger);
}
.calendar-wrap :deep(.fc-event.ev-workday) {
  background: var(--bg-selected);
  border: 1px solid var(--border);
  color: var(--text);
}
.calendar-wrap :deep(.fc-event.ev-workday .fc-event-title) {
  color: var(--text);
}
/* ICS 订阅：accent + 虚线描边（与里程碑实线蓝区分） */
.calendar-wrap :deep(.fc-event.ev-feed) {
  background: var(--accent);
  border: 1px dashed var(--bg-panel);
}

/* 提交热力角标：右下（避开右上日号），全绿阶 = heatBucket 档位。 */
.calendar-wrap :deep(.fc-daygrid-day) {
  position: relative;
}
.calendar-wrap :deep(.fc-daygrid-day[data-heat])::after {
  content: attr(data-heat);
  position: absolute;
  bottom: 3px;
  right: 3px;
  min-width: 14px;
  padding: 0 3px;
  border-radius: 7px;
  font-size: var(--font-xs);
  line-height: 14px;
  text-align: center;
  background: var(--bg-hover);
  color: var(--text-dim);
}
.calendar-wrap :deep(.fc-daygrid-day[data-heat-level="1"])::after {
  background: var(--success-soft);
  color: var(--text);
}
.calendar-wrap :deep(.fc-daygrid-day[data-heat-level="2"])::after {
  background: var(--success-soft);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--success);
}
.calendar-wrap :deep(.fc-daygrid-day[data-heat-level="3"])::after {
  background: var(--success);
  color: #fff;
}
.calendar-wrap :deep(.fc-daygrid-day[data-heat-level="4"])::after {
  background: var(--success);
  color: #fff;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
}

/* 农历副行：右上日号下方（初一显示月名，其余日名）。 */
.calendar-wrap :deep(.cal-lunar) {
  position: absolute;
  top: 17px;
  right: 3px;
  font-size: var(--font-xs);
  color: var(--text-dim);
  line-height: 1;
  pointer-events: none;
}
</style>
