<script setup lang="ts">
/**
 * 日历面板（工具类目）——FullCalendar v6（锁 6.1.21）月/列表视图。
 *
 * 图层模型（设计定案：日历 = 投影，不存数据、不做第二个日期真源）：
 *  - 投影：里程碑截止 / Issue·PR 创建 / 项目日期字段（读既有缓存，零存储）；
 *  - 提交热力：git_commit_activity 日格角标（装饰常显，不进图层菜单）；
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
import LoadStateHint from "../components/LoadStateHint.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useRepoStore } from "../stores/repo";
import { useIssuesStore } from "../stores/issues";
import { usePullsStore } from "../stores/pulls";
import { useProjectsStore } from "../stores/projects";
import { useSettingsStore } from "../stores/settings";
import { useCalendarStore } from "../stores/calendar";
import CalendarEventDialog from "./CalendarEventDialog.vue";
import { useI18n } from "../i18n";
import { api, isTauri } from "../api";
import { pushToast } from "../toast";
import type { CalendarEventRow, CalendarFeed, CalendarFeedEvent, LunarYmd } from "../api";
import { openExternalUrl } from "../open-url";
import {
  addDaysLocal,
  buildCalendarEvents,
  dateKey,
  expandOccurrences,
  heatBucket,
  layerPrio,
  type CalendarEventKind,
} from "./calendar-events";
import type { DateSelectArg } from "@fullcalendar/core";
import type { EventDropArg } from "@fullcalendar/core";
import type { EventApi } from "@fullcalendar/core";
import type { DateClickArg } from "@fullcalendar/interaction";

defineProps<{ leafId?: string; panelType?: string }>();

const repo = useRepoStore();
const { current } = storeToRefs(repo);
const issues = useIssuesStore();
const pulls = usePullsStore();
const projects = useProjectsStore();
const settings = useSettingsStore();
const calendar = useCalendarStore();
const { t, locale } = useI18n();

// ---- 图层开关（DropdownMenu multiple：保持展开连续勾选） ----

const PROJECTION_LAYERS: CalendarEventKind[] = ["milestone", "issue", "pull", "project"];
const visibleLayers = ref<string[]>([...PROJECTION_LAYERS, "event"]);

const layerOptions = computed(() => [
  { value: "milestone", label: t("calendar.layer.milestones"), color: "var(--accent)" },
  { value: "issue", label: t("calendar.layer.issues"), color: "var(--success)" },
  { value: "pull", label: t("calendar.layer.pulls"), color: "var(--merged)" },
  { value: "project", label: t("calendar.layer.projects"), color: "var(--text-dim)" },
  { value: "event", label: t("calendar.layer.events"), color: "var(--danger)" },
  ...feeds.value.map((f) => ({
    value: `feed:${f.id}`,
    label: f.name,
    color: f.color ?? "var(--accent)",
  })),
]);

// ---- 订阅 / 假日（应用级，不随仓库切换） ----

const feeds = ref<CalendarFeed[]>([]);
const feedEvents = ref<CalendarFeedEvent[]>([]);
let appLoaded = false;
let autoSyncStarted = false;
/** 订阅过期阈值：超 6 小时在面板打开时后台重拉（离线诚实跳过）。 */
const STALE_MS = 6 * 3600 * 1000;
// 可视区间（datesSet 维护）：重复日程按它展开
  const visibleRange = ref<{ from: string; to: string }>({
    from: dateKey(new Date()),
    to: dateKey(new Date()),
  });
  // 日程新建/编辑对话框（create 预填日期；edit 携带行）
  const dialogOpen = ref(false);
  /** 双击检测：单击不弹窗（防误触），同日 500ms 内两击才创建。 */
  let lastClick = { date: "", at: 0 };
  const creatingDate = ref<string | null>(null);
  const creatingEnd = ref<string | null>(null);
  const editing = ref<CalendarEventRow | null>(null);

  /** 解析器版本：升版时强制全量重同步一次（旧缓存是旧口径解析的）。 */
  const PARSER_VERSION = "2";
const PARSER_FLAG_KEY = "hivetask.feedParserVersion";

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
  let parserChanged = false;
  try {
    parserChanged = localStorage.getItem(PARSER_FLAG_KEY) !== PARSER_VERSION;
  } catch {
    parserChanged = true;
  }
  let touched = false;
  for (const feed of feeds.value) {
    if (!feed.enabled) continue;
    const stale =
      parserChanged ||
      !feed.lastSyncedAt ||
      Date.now() - lastSyncMs(feed.lastSyncedAt) > STALE_MS;
    if (!stale) continue;
    try {
      await api.calendarFeedSync(feed.id);
      touched = true;
    } catch {
      // 断网/失败：读缓存（错误信息不含 URL，后端红线）
    }
  }
  if (touched) {
    await refreshFeeds();
  }
  if (parserChanged) {
    try {
      localStorage.setItem(PARSER_FLAG_KEY, PARSER_VERSION);
    } catch {
      // 下次打开再试一次，无害
    }
  }
}

async function ensureAppData(): Promise<void> {
  if (appLoaded || !isTauri()) return;
  appLoaded = true;
  await refreshFeeds();
  void autoSyncStale();
}

// ---- 农历副行（应用级；预取今天 ±370 天，超出再补拉） ----
  /** 结构化农历（每年农历重复的匹配）：date → {month, day, leap}。 */
  const lunarYmdMap = ref<Map<string, LunarYmd>>(new Map());
  /** 每年农历日程的锚点：eventId → 起始日的农历月日。 */
  const lunarAnchor = ref<Map<string, LunarYmd>>(new Map());

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

/** 提交热力（日格角标）——刻意不进图层菜单：装饰语义，非事件层。
 *  数据存 calendar store（按仓库键控，应用级缓存）：切工作区卸载面板不再清零，
 *  缓存命中时挂载即有角标，无「重挂后等异步拉取」的空窗。 */
const EMPTY_HEAT: ReadonlyMap<string, number> = new Map();
// 注意:Pinia store 实例上的 ref 自动解包——calendar.commitHeat 就是 Map,没有 .value
const commitCounts = computed<ReadonlyMap<string, number>>(
  () => (current.value ? calendar.commitHeat.get(current.value) ?? EMPTY_HEAT : EMPTY_HEAT),
);
/** 数据到达时 bump：强制 FullCalendar 重挂载，重跑 dayCellDidMount。 */
const calKey = ref(0);
/** 等待态：无仓库缓存的首载期（以热力拉取为信号，最慢的一路）。缓存命中不闪。 */
const calLoading = ref(true);

// ---- 事件装配 ----

interface FcEvent {
  id: string;
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  extendedProps: { url: string | null; localId?: string };
  classNames: string[];
  startEditable?: boolean;
  backgroundColor?: string;
  borderColor?: string;
  textColor?: string;
}

/** 各图层事件色（月视图实底 / 列表视图色点同源）。 */
const KIND_BORDER: Record<CalendarEventKind, string> = {
  milestone: "var(--accent)",
  issue: "var(--success)",
  pull: "var(--merged)",
  project: "var(--text-dim)",
};

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
      borderColor: KIND_BORDER[e.kind],
    }));

  const extras: FcEvent[] = [];
  // 本地日程（C 类图层：用户手建，红 = 我的事）。重复日程按可视区间展开
  // 发生日；fc 全天 end 为排他端点（结束日 +1），timed 用 ISO 时刻。
  if (visibleLayers.value.includes("event")) {
    const { from, to } = visibleRange.value;
    for (const e of calendar.events) {
      const delta = e.endDate
        ? Math.round((new Date(e.endDate).getTime() - new Date(e.startDate).getTime()) / 86400e3)
        : 0;
      // 每年农历：锚点农历月日逐一比对可视区间各日
      const occs =
        e.recur === "lunar"
          ? (() => {
              const anchor = lunarAnchor.value.get(e.id);
              if (!anchor) return [];
              const out: string[] = [];
              let cur = from;
              let guard = 0;
              while (cur <= to && guard < 400) {
                guard++;
                const y = lunarYmdMap.value.get(cur);
                if (
                  y &&
                  y.month === anchor.month &&
                  y.day === anchor.day &&
                  y.leap === anchor.leap
                ) {
                  out.push(cur);
                }
                cur = addDaysLocal(cur, 1);
              }
              return out;
            })()
          : expandOccurrences(e.startDate, e.endDate, e.recur, from, to);
      for (const occ of occs) {
        const occEnd = delta > 0 ? addDaysLocal(occ, delta) : occ;
        extras.push({
          id: `event:${e.id}:${occ}`,
          title: e.title,
          allDay: e.allDay,
          start: e.allDay ? occ : `${occ}T${e.startTime ?? "00:00"}:00`,
          end: e.allDay
            ? e.endDate
              ? addDaysLocal(occEnd, 1)
              : undefined
            : e.endDate
              ? `${occEnd}T${e.endTime ?? "23:59"}:00`
              : e.startTime
                ? `${occ}T${e.startTime}:00`
                : undefined,
          extendedProps: { url: null, localId: e.id },
          classNames: ["ev-event"],
          startEditable: !e.recur, // 重复日程拖拽 = 改系列锚点，v1 禁拖（revert）
        });
      }
    }
  }
  const feedColor = new Map(feeds.value.map((f) => [f.id, f.color]));
  for (const f of feedEvents.value) {
    if (visibleLayers.value.includes(`feed:${f.feedId}`)) {
      const color = feedColor.get(f.feedId) ?? null;
      extras.push({
        id: `feed:${f.feedId}:${f.date}:${f.title}`,
        title: f.title,
        start: f.date,
        extendedProps: { url: null },
        classNames: color ? [] : ["ev-feed"],
        backgroundColor: color ?? undefined,
        borderColor: color ?? "var(--accent)",
        textColor: color ? "#fff" : undefined,
      });
    }
  }
  return [...projections, ...extras];
});

/** 事件条交互：格内 chip 单击不动作（防误触，与日期格双击同一手势语言）、双击执行；
 *  「+N 更多」popover 内 = 用户已明确展开该日列表，单击即执行。
 *  执行 = 本地日程开编辑对话框；带线上链接的 chip 跳浏览器。 */
let lastEventClick = { id: "", at: 0 };
function onEventClick(info: EventClickArg): void {
  const inPopover = (info.jsEvent.target as HTMLElement | null)?.closest(".fc-more-popover") != null;
  if (!inPopover) {
    const key = info.event.id;
    const now = Date.now();
    const isDouble = lastEventClick.id === key && now - lastEventClick.at < 500;
    lastEventClick = { id: key, at: now };
    if (!isDouble) return;
  }

  const url = info.event.extendedProps?.url as string | undefined;
  if (url) {
    openExternalUrl(url);
    return;
  }
  const localId = info.event.extendedProps?.localId as string | undefined;
  if (localId) {
    const row = calendar.events.find((e) => e.id === localId);
    if (row) {
      editing.value = row;
      dialogOpen.value = true;
    }
  }
}

/** 导出全部手建日程为 .ics（系统日历「导出出」半边）：保存对话框 → Rust 写文件 → toast 回执。 */
async function exportIcs(): Promise<void> {
  if (!isTauri()) return;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: "hivetask-events.ics",
    filters: [{ name: "iCalendar", extensions: ["ics"] }],
  });
  if (!path) return;
  try {
    const n = await api.calendarExportIcs(path);
    pushToast({ kind: "success", message: t("calendar.export.done", { n }) });
  } catch (e) {
    pushToast({ kind: "error", message: t("calendar.export.failed", { error: String(e) }) });
  }
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
  // 折叠/展示优先级：日程、节气/假日压过投影类（用户定案），同层回退 fc 默认链
  //（'start,-duration,allDay,title'——与 fc 内置默认一致，函数后须显式补上）。
  // 类型债：fc 运行时 parseFieldSpecs 接受「函数 + 字段串」数组，但类型窄化为 string。
  eventOrder: [
    (a: EventApi, b: EventApi) => layerPrio(a.id) - layerPrio(b.id),
    "start",
    "-duration",
    "allDay",
    "title",
  ] as unknown as string,
  eventClick: onEventClick,  datesSet: (arg: DatesSetArg) => {
    visibleRange.value = { from: dateKey(arg.start), to: dateKey(arg.end) };
    void ensureLunar(arg.start, arg.end);
  },
  // 双击日期 → 新建日程（单击不动作，防误触）；拖选区间 → 预填起止（fc end 为排他，转含端）
  dateClick: (arg: DateClickArg) => {
    const now = Date.now();
    if (lastClick.date === arg.dateStr && now - lastClick.at < 500) {
      lastClick = { date: "", at: 0 };
      creatingDate.value = arg.dateStr;
      creatingEnd.value = null;
      editing.value = null;
      dialogOpen.value = true;
    } else {
      lastClick = { date: arg.dateStr, at: now };
    }
  },
  editable: true,
  eventDrop: (arg: EventDropArg) => {
    const localId = arg.event.extendedProps?.localId as string | undefined;
    const row = localId ? calendar.events.find((e) => e.id === localId) : undefined;
    if (!row || row.recur) {
      arg.revert(); // 重复日程拖拽 = 改系列锚点，v1 不做
      return;
    }
    const newStart = dateKey(arg.event.start ?? new Date(row.startDate));
    const delta = Math.round(
      (new Date(newStart).getTime() - new Date(row.startDate).getTime()) / 86400e3,
    );
    const newEnd = row.endDate
      ? addDaysLocal(row.endDate, delta)
      : null;
    void calendar
      .update(
        row.id,
        row.title,
        newStart,
        newEnd,
        row.allDay,
        row.startTime,
        row.endTime,
        row.notes,
        row.remindAt,
        row.recur,
      )
      .catch(() => {
        // 失败回滚拖拽位置
      });
  },
  selectable: true,
  select: (arg: DateSelectArg) => {
    // selectable 开启时单击也会触发「零长度 select」（start=end）——那是一次点击
    // 不是拖选：忽略，创建走双击门槛。拖选必须真跨 ≥2 天才建。
    if (arg.end.getTime() - arg.start.getTime() <= 86400e3) return;
    creatingDate.value = dateKey(arg.start);
    creatingEnd.value = dateKey(new Date(arg.end.getTime() - 86400e3));
    editing.value = null;
    dialogOpen.value = true;
  },
  // 日格挂载：提交热力 data-heat(-level)（::after 渲染）+ 农历副行（追加 span）
  dayCellDidMount: (arg: DayCellMountArg) => {
    // fc 在「+N 更多」popover 内部还会挂一个隐藏 DayCellContainer（命中检测用），
    // 对它执行挂载会把农历 span 叠到 popover 标题上、热力角标画进 popover——跳过。
    if (arg.el.closest(".fc-more-popover")) return;
    const n = commitCounts.value.get(dateKey(arg.date));
    if (n) {
      arg.el.setAttribute("data-heat", String(n));
      arg.el.setAttribute("data-heat-level", String(heatBucket(n)));
      arg.el.setAttribute("title", t("calendar.heatTooltip", { n }));
    }
    const lunarText = settings.lunarLine ? lunarMap.value.get(dateKey(arg.date)) : undefined;
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
    if (!path || !isTauri()) {
      calLoading.value = false; // 无仓库/浏览器预览：不显示等待态
      return;
    }
    void issues.loadCache().catch(() => {});
    void pulls.loadCache().catch(() => {});
    void issues.loadMilestones(path).catch(() => {});
    if (projects.items.length === 0 && projects.fields.length === 0) {
      void projects.loadAll().catch(() => {});
    }
    // 等待态以热力拉取为信号（最慢的一路）；缓存命中即关，不闪进度条
    calLoading.value = true;
    // 热力走 store 缓存：新拉取成功才重挂补角标；缓存命中时挂载即有，不 bump
    void calendar.ensureCommitHeat(path).then((fresh) => {
      calLoading.value = false;
      if (fresh) calKey.value += 1;
    });
  },
  { immediate: true },
);

// 设置里关/开副行 → 重挂载立即生效
watch(
  () => settings.lunarLine,
  () => {
    calKey.value += 1;
  },
);

// 每年农历日程：解析起始日农历锚点（缺失即取，取完重挂载）
async function ensureLunarAnchors(): Promise<void> {
  if (!isTauri()) return;
  let fetched = false;
  for (const e of calendar.events.filter((x) => x.recur === "lunar")) {
    if (lunarAnchor.value.has(e.id)) continue;
    try {
      lunarAnchor.value.set(e.id, await api.calendarLunarYmd(e.startDate));
      fetched = true;
    } catch {
      lunarAnchor.value.set(e.id, { month: 0, day: 0, leap: false });
    }
  }
  if (fetched) calKey.value += 1;
}
watch(() => calendar.events, () => void ensureLunarAnchors(), { deep: true });

onMounted(() => {
  void calendar.ensureEvents();
  void ensureAppData();
  const now = new Date();
  void ensureLunar(new Date(now.getTime() - 370 * 86400e3), new Date(now.getTime() + 370 * 86400e3));
});
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template #actions>
      <button class="icon-btn" type="button" :title="t('calendar.export')" @click="exportIcs">
        <EditorIcon name="o.download" />
      </button>
      <DropdownMenu v-model="visibleLayers" multiple checkbox :options="layerOptions">
        <template #trigger="{ open, toggle }">
          <button class="layer-btn" :class="{ open }" type="button" @click="toggle">
            <EditorIcon name="o.stack" />
            <span>{{ t("calendar.layers") }}</span>
          </button>
        </template>
      </DropdownMenu>
    </template>
    <div class="calendar-wrap" :class="{ 'cal-loading': calLoading }">
      <div v-if="calLoading" class="cal-progress" aria-hidden="true" />
      <LoadStateHint v-if="!current" state="empty" :text="t('calendar.noRepo')" />
      <FullCalendar v-else :key="calKey" :options="options" />
    </div>
    <CalendarEventDialog
      v-if="dialogOpen"
      :mode="editing ? 'edit' : 'create'"
      :date="creatingDate"
      :event="editing"
      @close="dialogOpen = false"
    />
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
/* 导出按钮：与图层按钮同高同描边，纯图标形态 */
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  cursor: pointer;
  outline: none;
}
.icon-btn:hover {
  background: var(--bg-hover);
}
.layer-btn:hover,
.layer-btn.open {
  border-color: var(--accent);
  color: var(--accent);
}

.calendar-wrap {
  position: relative;
  height: 100%;
  min-height: 0;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
}
/* 等待态：顶部细进度条（accent 滑块横扫）+ 网格降透明度；
   prefers-reduced-motion 下进度条静止为细线。 */
.cal-progress {
  position: absolute;
  top: 0;
  left: 0;
  height: 2px;
  width: 30%;
  background: var(--accent);
  border-radius: 1px;
  animation: cal-progress-sweep 1.1s ease-in-out infinite;
  z-index: 5;
}
@keyframes cal-progress-sweep {
  from { left: -30%; }
  to { left: 100%; }
}
.calendar-wrap.cal-loading :deep(.fc) {
  opacity: 0.55;
  transition: opacity 0.2s;
}
@media (prefers-reduced-motion: reduce) {
  .cal-progress { animation: none; left: 0; width: 100%; opacity: 0.5; }
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
  --fc-today-bg-color: var(--accent-soft);
  --fc-neutral-bg-color: var(--bg-app);
  --fc-event-border-color: transparent;
  --fc-more-link-bg-color: transparent;
  --fc-more-link-text-color: var(--text-dim);
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
  /* inline-flex 居中：fc 默认按钮内 chevron 为图标字体，22px 高下会坐不到垂直中线 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 22px;
  padding: 0 7px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font-size: var(--font-md);
  font-weight: 400;
  line-height: 1;
  text-transform: none;
  box-shadow: none;
}
.calendar-wrap :deep(.fc .fc-icon) {
  line-height: 1;
  font-size: var(--icon-size, 14px);
  vertical-align: middle;
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
/* 分页组（‹|›）：接成一体——共享边框、端点圆角（今天/视图切换保持独立圆角） */
.calendar-wrap :deep(.fc .fc-button-group) {
  gap: 0;
}
.calendar-wrap :deep(.fc .fc-button-group > .fc-button) {
  border-radius: 0;
  margin-left: -1px;
}
.calendar-wrap :deep(.fc .fc-button-group > .fc-button:first-child) {
  border-radius: 6px 0 0 6px;
  margin-left: 0;
}
.calendar-wrap :deep(.fc .fc-button-group > .fc-button:last-child) {
  border-radius: 0 6px 6px 0;
}
/* 双击创建会触发原生文字选择——月网格禁选字（列表视图保留可复制） */
.calendar-wrap :deep(.fc-daygrid),
.calendar-wrap :deep(.fc-col-header) {
  user-select: none;
  -webkit-user-select: none;
}
/* 今日强调（用户反馈「今日不明显」）：底色 accent-soft + 日号反色药丸 */
.calendar-wrap :deep(.fc .fc-day-today .fc-daygrid-day-number) {
  background: var(--accent);
  color: #fff;
  border-radius: 999px;
  padding: 1px 7px;
  margin: 1px 2px;
  line-height: 1.25;
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
/* 列表视图（listMonth 作用域）：行 = 色点 + 时间 + 标题——实底条是月视图
   语言，列表里压迫且无悬停反馈；色点颜色 = 事件 borderColor（图层色/订阅色） */
.calendar-wrap :deep(.fc .fc-listMonth-view .fc-list-event) {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 4px 10px;
  cursor: pointer;
}
.calendar-wrap :deep(.fc .fc-listMonth-view .fc-list-event:hover) {
  background: var(--bg-hover);
}
.calendar-wrap :deep(.fc-event) {
  cursor: default;
  font-size: var(--font-xs);
  line-height: 1.3;
}
.calendar-wrap :deep(.fc .fc-dayGridMonth-view .fc-event.ev-milestone) {
  background: var(--accent);
}
.calendar-wrap :deep(.fc .fc-dayGridMonth-view .fc-event.ev-issue) {
  background: var(--success);
}
.calendar-wrap :deep(.fc .fc-dayGridMonth-view .fc-event.ev-pull) {
  background: var(--merged);
}
/* 项目日期字段：中性灰（非平台状态色，避免误导为远端实体） */
.calendar-wrap :deep(.fc .fc-dayGridMonth-view .fc-event.ev-project) {
  background: var(--bg-selected);
  border: 1px solid var(--border);
  color: var(--text);
}
.calendar-wrap :deep(.fc .fc-dayGridMonth-view .fc-event.ev-project .fc-event-title) {
  color: var(--text);
}
/* 本地日程（用户手建）：红实底——我的事，最强视觉 */
.calendar-wrap :deep(.fc .fc-dayGridMonth-view .fc-event.ev-event) {
  background: var(--danger);
}
/* ICS 订阅：accent + 虚线描边（与里程碑实线蓝区分） */
.calendar-wrap :deep(.fc .fc-dayGridMonth-view .fc-event.ev-feed) {
  background: var(--accent);
  border: 1px dashed var(--bg-panel);
}

/* ---- 「+N 更多」折叠链与当日 popover（dayMaxEvents 溢出面）----
   fc 的 popover 底色吃 --fc-page-bg-color，而月网格把它置成 transparent
   —— 不收口 popover 就是全透明底叠在日格上。形态对齐菜单规范：
   --bg-panel 纯色底 + 浅投影 + --border 描边，无渐变；暗色随 token 自动。 */
.calendar-wrap :deep(.fc .fc-more-link) {
  font-size: var(--font-xs);
  color: var(--text-dim);
  padding: 1px 4px;
  border-radius: 4px;
}
.calendar-wrap :deep(.fc .fc-more-link:hover) {
  color: var(--text);
  background: var(--bg-hover);
  text-decoration: none;
}
.calendar-wrap :deep(.fc .fc-more-popover) {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  min-width: 200px;
  max-width: 300px;
}
.calendar-wrap :deep(.fc .fc-more-popover .fc-popover-header) {
  background: var(--bg-chip);
  border-bottom: 1px solid var(--border);
  border-radius: 8px 8px 0 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.calendar-wrap :deep(.fc .fc-more-popover .fc-popover-close) {
  color: var(--text-dim);
  font-size: var(--font-base);
}
.calendar-wrap :deep(.fc .fc-more-popover .fc-popover-close:hover) {
  color: var(--text);
  opacity: 1;
}
.calendar-wrap :deep(.fc .fc-more-popover .fc-popover-body) {
  max-height: 240px;
  overflow: auto;
  padding: 4px;
}
/* popover 内事件 chip：与月视图同款配色（ popover 挂载点不在 .fc-dayGridMonth-view 内，
   现有视图限定规则不命中，此处补一段同源选择）。 */
.calendar-wrap :deep(.fc .fc-more-popover .fc-event.ev-milestone) {
  background: var(--accent);
}
.calendar-wrap :deep(.fc .fc-more-popover .fc-event.ev-issue) {
  background: var(--success);
}
.calendar-wrap :deep(.fc .fc-more-popover .fc-event.ev-pull) {
  background: var(--merged);
}
.calendar-wrap :deep(.fc .fc-more-popover .fc-event.ev-project) {
  background: var(--bg-selected);
  border: 1px solid var(--border);
  color: var(--text);
}
.calendar-wrap :deep(.fc .fc-more-popover .fc-event.ev-event) {
  background: var(--danger);
}
.calendar-wrap :deep(.fc .fc-more-popover .fc-event.ev-feed) {
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

/* 农历副行：左上角，与右上日号同行（经典日历排版）；事件 chip 在下方流式
   排列，互不重叠；热力角标在右下。可在设置「农历副行」关闭（订阅了含农历
   的日历源时去重用）。 */
.calendar-wrap :deep(.cal-lunar) {
  position: absolute;
  top: 3px;
  left: 4px;
  font-size: var(--font-xs);
  color: var(--text-dim);
  line-height: 1;
  pointer-events: none;
}
</style>
