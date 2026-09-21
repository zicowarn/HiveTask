<script setup lang="ts">
/**
 * Roadmap 布局（对齐平台 views/4?layout=roadmap，2026-09 取证像素实测）：
 * 工具栏右对齐 [◎ Markers | ⇅ Sort | 📅 Date fields | Month | Today | ‹ ›]；
 * 时间轴双向无限：滚动接近两端自动扩充日期（scrollLeft 补偿无跳变），
 * 月标签行 + 日号行（今日=红点）随时间轴滚动，左字段列吸附固定
 * （宽可拖拽 240–800）；日宽 48px，周末列底纹，周一深色周线；行高 40px，
 * 字段格有行线、时间轴无行线；有日期画白色卡片条（可拖拽改期），无日期
 * 行内 ←/＋ 添加到今天；字段列底部 Add item 行（共享 omnibar）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useProjectsStore } from "../../stores/projects";
import { api, type ProjectItem } from "../../api";
import { useI18n } from "../../i18n";
import { itemTitle } from "../item-fields";
import EditorIcon from "../../components/EditorIcon.vue";
import DropdownMenu from "../../components/DropdownMenu.vue";
import ActionMenu, { type ActionItem } from "../../components/ActionMenu.vue";
import ProjectOmnibar from "../ProjectOmnibar.vue";
import IssueCreateDialog from "../IssueCreateDialog.vue";
import ProjectAddItemsDrawer from "../ProjectAddItemsDrawer.vue";
import { pushToast } from "../../toast";

const store = useProjectsStore();
const { filteredItems, fields, selectedId } = storeToRefs(store);
const { t } = useI18n();

// ---- 日期字段（Start / End）----
const dateFields = computed(() => fields.value.filter((f) => f.kind === "date"));
const dateFieldId = ref<string>("");
const activeDateField = computed(
  () => dateFields.value.find((f) => f.id === dateFieldId.value) ?? dateFields.value[0] ?? null,
);
const endField = computed(
  () => dateFields.value.find((f) => f.id === store.view.dateEndFieldId) ?? null,
);

// ---- 工具栏（平台右对齐）----
const sortOptions = [
  { value: "manual", label: t("project.sortManual") },
  { value: "added", label: t("project.sortAdded") },
  { value: "priority", label: t("project.sortPriority") },
];
const zoom = ref<"month" | "week">("month");
const dayWidth = computed(() => (zoom.value === "month" ? 48 : 96));
const today = new Date();

// ---- 双向无限时间轴：rangeFrom/To 随滚动自动扩充 ----
const DAY = 86_400_000;
const EXTEND_DAYS = 30;
const rangeFrom = ref(new Date(today.getFullYear(), today.getMonth(), 1));
const rangeTo = ref(new Date(today.getFullYear(), today.getMonth() + 2, 0));

/** 字段列宽按整天吸附（平台：拖拽手柄落在日界上）。k = 列宽折合天数，
 * 时间轴刻度比条目区向左延伸 k 天——表头横贯全宽，字段列上方也是日期。 */
const kDays = computed(() => Math.round(fieldW.value / dayWidth.value));

/** 表头日序列：比条目区早 k 天起（覆盖字段列上方），到 rangeTo 止。 */
const days = computed(() => {
  const out: Date[] = [];
  const start = rangeFrom.value.getTime() - kDays.value * DAY;
  for (let t = start; t <= rangeTo.value.getTime(); t += DAY) {
    out.push(new Date(t));
  }
  return out;
});
/** 条目区（时间轴）的日序列 = 表头日序列去掉字段列上方那 k 天。 */
const trackDays = computed(() => days.value.slice(kDays.value));
const totalDays = computed(() => trackDays.value.length);
const gridWidth = computed(() => totalDays.value * dayWidth.value);
const months = computed(() => {
  const out: { key: string; label: string; start: number; span: number }[] = [];
  days.value.forEach((d, i) => {
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const label = d.toLocaleDateString(undefined, { year: "numeric", month: "long" });
    const last = out[out.length - 1];
    if (!last || last.key !== key) out.push({ key, label, start: i * dayWidth.value, span: 1 });
    else last.span += 1;
  });
  return out;
});

function shiftRange(dir: -1 | 1) {
  const f = new Date(rangeFrom.value);
  f.setMonth(f.getMonth() + dir);
  const t = new Date(rangeTo.value);
  t.setMonth(t.getMonth() + dir);
  rangeFrom.value = f;
  rangeTo.value = t;
}
function goToday() {
  rangeFrom.value = new Date(today.getFullYear(), today.getMonth(), 1);
  rangeTo.value = new Date(today.getFullYear(), today.getMonth() + 2, 0);
  void scrollTodayIntoView();
}

function dateOf(item: ProjectItem): Date | null {
  const field = activeDateField.value;
  if (!field) return null;
  const raw = item.fieldValues[field.id];
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
function endOf(item: ProjectItem): Date | null {
  const field = endField.value;
  if (!field) return null;
  const raw = item.fieldValues[field.id];
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
function offsetOf(date: Date): number {
  return ((date.getTime() - rangeFrom.value.getTime()) / DAY) * dayWidth.value;
}
function barStyle(item: ProjectItem): Record<string, string> | null {
  const start = dateOf(item);
  if (!start) return null;
  const end = endOf(item);
  const left = offsetOf(start);
  const width = end && end > start ? offsetOf(end) - left + dayWidth.value : dayWidth.value;
  return { left: left + "px", width: width + "px" };
}
const todayIndex = computed(() => {
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return days.value.findIndex((d) => d.getTime() === t0.getTime());
});

// ---- 泳道维度（如优先级）分组：激活时按选项分组渲染，无值段置底；
// 行号跨组连续；展开/收起与 Table 分组共用 isLaneCollapsed ----
const swimGrouped = computed(() => !!store.swimlaneField);
const roadmapGroups = computed(() => {
  const f = store.swimlaneField;
  if (!f) {
    return [
      { id: "__flat__", name: null as string | null, color: null as string | null, items: filteredItems.value, start: 0 },
    ];
  }
  let n = 0;
  return store
    .swimlaneOptions()
    .filter((o) => !store.isHidden("lane", o.id))
    .map((o) => {
      const items = filteredItems.value.filter((i) => (i.fieldValues[f.id] ?? "") === o.id);
      const g = {
        id: o.id,
        name: o.id === "" ? t("project.columnNoValue", { field: f.name }) : o.name,
        color: o.color || null,
        items,
        start: n,
      };
      n += items.length;
      return g;
    });
});

// ---- 范围覆盖条目日期：卡片日期早于/晚于当前范围时自动扩张（只增不减，
// 不动用户视口）。否则卡片画在画布负坐标区——← 箭头亮着却永远跳不到。----
watch([filteredItems, activeDateField], () => {
  const times = filteredItems.value
    .map(dateOf)
    .filter((d): d is Date => !!d)
    .map((d) => d.getTime());
  if (!times.length) return;
  const min = Math.min(...times);
  const max = Math.max(...times);
  if (min < rangeFrom.value.getTime()) rangeFrom.value = new Date(min);
  if (max > rangeTo.value.getTime()) rangeTo.value = new Date(max);
});

// ---- 滚动扩充（双向无限）：近边缘自动前置/追加 30 天；前置用 scrollLeft
// 补偿，视觉零跳变。视口状态（scrollLeft/宽）同时驱动卡片的「越界箭头」。----
const scrollEl = ref<HTMLElement | null>(null);
const extending = ref(false);
const viewLeft = ref(0);
const viewW = ref(0);
function updateView() {
  const el = scrollEl.value;
  if (!el) return;
  viewLeft.value = el.scrollLeft;
  viewW.value = el.clientWidth;
}
/** 箭头显隐的刷新时机：滚动停止后 120ms。滚动帧内不写响应式状态——
 * 否则每帧全组件重渲染（几百个日格的 diff），sticky 左列会跟着抖。 */
let viewTimer: ReturnType<typeof setTimeout> | undefined;
async function onScroll() {
  if (!scrollEl.value) return;
  const el = scrollEl.value;
  if (extending.value) return;
  const leadPx = dayWidth.value * 7;
  if (el.scrollLeft < leadPx) {
    extending.value = true;
    rangeFrom.value = new Date(rangeFrom.value.getTime() - EXTEND_DAYS * DAY);
    const shiftPx = EXTEND_DAYS * dayWidth.value;
    await nextTick();
    el.scrollLeft += shiftPx;
    extending.value = false;
    return;
  }
  const rightEdge = fieldW.value + totalDays.value * dayWidth.value;
  if (el.scrollLeft + el.clientWidth > rightEdge - leadPx) {
    extending.value = true;
    rangeTo.value = new Date(rangeTo.value.getTime() + EXTEND_DAYS * DAY);
    await nextTick();
    extending.value = false;
    return;
  }
  window.clearTimeout(viewTimer);
  viewTimer = setTimeout(updateView, 120);
}

// ---- 卡片越界跳转（平台 ←/→）：卡片完全滚出可视时间轴时，
// 行内出现箭头（左出 = 列尾 ←、右出 = 视口右缘 →），点击滚回卡片。----
function barRect(item: ProjectItem): { left: number; right: number } | null {
  const start = dateOf(item);
  if (!start) return null;
  const left = fieldW.value + offsetOf(start);
  const end = endOf(item);
  const width = end && end > start ? offsetOf(end) - offsetOf(start) + dayWidth.value : dayWidth.value;
  return { left, right: left + width };
}
function isOffLeft(item: ProjectItem): boolean {
  const r = barRect(item);
  return !!r && r.right <= viewLeft.value + fieldW.value;
}
function isOffRight(item: ProjectItem): boolean {
  const r = barRect(item);
  return !!r && r.left >= viewLeft.value + viewW.value;
}
function jumpTo(item: ProjectItem) {
  const r = barRect(item);
  if (!r || !scrollEl.value) return;
  scrollEl.value.scrollLeft = Math.max(0, r.left - fieldW.value - 16);
}

// ---- 字段列宽度（平台：表头角部 ⇔ 拖拽手柄，240–800）----
const FIELD_MIN = 240;
const FIELD_MAX = 768; /* 16 天：列宽按整天吸附（平台手柄落在日界上） */
const fieldW = ref(480);
const fieldDrag = ref<{ startX: number; startW: number } | null>(null);
function beginFieldDrag(event: PointerEvent) {
  event.preventDefault(); // 阻断原生文本选择（拖拽列宽时日号被选中的蓝框）
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  fieldDrag.value = { startX: event.clientX, startW: fieldW.value };
}
function onFieldDragMove(event: PointerEvent) {
  if (!fieldDrag.value) return;
  fieldW.value = Math.min(FIELD_MAX, Math.max(FIELD_MIN, Math.round((fieldDrag.value.startW + (event.clientX - fieldDrag.value.startX)) / dayWidth.value) * dayWidth.value));
}
function endFieldDrag() {
  fieldDrag.value = null;
}

// ---- 条目：有日期画卡片条（拖拽改期），无日期 ←/＋ 添加到今天 ----
function dateIsoShift(iso: string, days: number): string {
  const x = new Date(iso);
  x.setDate(x.getDate() + days);
  return x.toISOString().slice(0, 10);
}
const drag = ref<{ id: string; mode: "move" | "start" | "end"; startX: number; days: number } | null>(null);
function beginDrag(item: ProjectItem, mode2: "move" | "start" | "end", event: PointerEvent) {
  if (!dateOf(item)) return;
  event.preventDefault(); // 同上：拖卡片时不选中原文本
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  drag.value = { id: item.id, mode: mode2, startX: event.clientX, days: 0 };
}
function onDragMove(event: PointerEvent) {
  if (!drag.value) return;
  drag.value.days = Math.round((event.clientX - drag.value.startX) / dayWidth.value);
}
async function endDrag(item: ProjectItem) {
  const d = drag.value;
  drag.value = null;
  if (!d || !d.days) return;
  const startField = activeDateField.value;
  const endFieldRef = endField.value;
  const shiftIso = (iso: string) => dateIsoShift(iso, d.days);
  const startRaw = startField ? item.fieldValues[startField.id] : undefined;
  const endRaw = endFieldRef ? item.fieldValues[endFieldRef.id] : undefined;
  if (startField && startRaw && d.mode !== "end") {
    await store.setFieldValue(item.id, startField.id, shiftIso(startRaw));
  }
  if (endFieldRef && endRaw && d.mode !== "start") {
    await store.setFieldValue(item.id, endFieldRef.id, shiftIso(endRaw));
  }
}
function dragOffset(item: ProjectItem): number {
  const d = drag.value;
  if (!d || d.id !== item.id) return 0;
  return d.days * dayWidth.value;
}
/** 无日期条目：平台 ←/＋（按状态分图标）→ 写入今天为开始日期。 */
async function addToToday(item: ProjectItem) {
  const field = activeDateField.value;
  if (!field) return;
  const iso = new Date().toISOString().slice(0, 10);
  await store.setFieldValue(item.id, field.id, iso);
}
/** ＋ 的提示（平台 "Add to today <日期>"）：带上将写入的具体日期。 */
const addToTodayTip = computed(
  () => `${t("roadmap.addToToday")} ${today.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
);

// ---- 行号 ▾ 菜单（平台：悬停展开；Archive [E] / Remove from project [Del] /
// Move item）。Archive 需归档字段数据面，点击暂以提示挂账（同 Markers 口径）；
// Move item 的落点子菜单为桌面适配（平台是拖拽编排） ----
function rowMenuItems(item: ProjectItem): ActionItem[] {
  const status = store.columnField;
  const cur = status ? (item.fieldValues[status.id] ?? "") : "";
  const out: ActionItem[] = [
    { value: "archive", label: t("project.actArchive"), icon: "o.archive", badge: "E" },
    {
      value: "remove",
      label: t("project.actRemoveFromProject"),
      icon: "o.trash",
      danger: true,
      badge: "Del",
    },
  ];
  if (status && status.options.length > 1) {
    out.push({
      value: "move",
      label: t("project.actMoveItem"),
      icon: "o.grabber",
      dividerBefore: true,
      noChevron: true, /* 平台该行只有左 grabber，右侧无子菜单箭头 */
      submenu: status.options
        .filter((o) => o.id !== cur)
        .map((o) => ({ value: `move:${o.id}`, label: o.name })),
    });
  }
  return out;
}
async function onRowMenuPick(item: ProjectItem, value: string) {
  if (value.startsWith("move:")) await store.moveItem(item.id, value.slice(5));
  else if (value === "remove") await store.removeItem(item.id);
  else if (value === "archive") pushToast({ kind: "info", message: t("project.archiveTodo") });
}

// ---- Add item 行（共享 omnibar + Create dialog + 抽屉）----
const omni = ref<InstanceType<typeof ProjectOmnibar> | null>(null);
const omniOpen = ref(false);
/** 泳道分组模式下正在添加的组（每组独立 Add item 行，落入该组；
 *  共享底行仅扁平模式渲染）。 */
const addingGroup = ref<string | null>(null);
const groupOmni = ref<InstanceType<typeof ProjectOmnibar> | null>(null);
function setGroupOmni(el: unknown) {
  groupOmni.value = el as InstanceType<typeof ProjectOmnibar> | null;
}
async function startGroupAdd(gid: string) {
  addingGroup.value = gid;
  await nextTick();
  groupOmni.value?.open();
}
const createOpen = ref(false);
const drawerOpen = ref(false);
const repoChoices = ref<
  { id: string; label: string; visibility?: string | null; target: string; remoteUrl?: string | null }[]
>([]);
const repoMenu = ref<{ value: string; label: string; target: string; visibility: string | null }[]>([]);
async function ensureRepos() {
  if (repoChoices.value.length) return;
  try {
    const rows = (await api.repoList()) as Array<{ id: string; displayName?: string | null; path?: string | null; remoteUrl?: string | null; visibility?: string | null }>;
    repoChoices.value = rows.map((r) => ({
      id: r.id,
      label: r.displayName ?? r.path?.split("/").filter(Boolean).pop() ?? r.remoteUrl ?? r.id,
      visibility: r.visibility ?? null,
      target: r.path ?? r.remoteUrl ?? r.id,
      remoteUrl: r.remoteUrl ?? null,
    }));
  } catch {
    repoChoices.value = [];
  }
}
async function ensureRepoMenu() {
  await ensureRepos();
  const all = repoChoices.value.map((r) => ({
    value: r.id,
    label: r.label,
    target: r.target,
    visibility: r.visibility ?? null,
  }));
  const bound = store.boundRepos
    .filter((b) => !!b.target)
    .map((b) => ({
      value: b.repoId,
      label: b.label,
      target: b.target,
      visibility: all.find((a) => a.value === b.repoId)?.visibility ?? null,
    }));
  const merged = [...bound];
  for (const r of all) if (!merged.some((m) => m.value === r.value)) merged.push(r);
  repoMenu.value = merged;
}
async function openAdd() {
  omniOpen.value = true;
  await nextTick();
  omni.value?.open();
}
async function submitAdd(title: string, groupId?: string) {
  if (!selectedId.value) return;
  const created = await store.addItem({ projectId: selectedId.value, kind: "draft", draftTitle: title });
  if (created && groupId && store.swimlaneField) {
    await store.setFieldValue(created.id, store.swimlaneField.id, groupId);
  }
}
function openCreateDialog() {
  omni.value?.close();
  groupOmni.value?.close();
  omniOpen.value = false;
  void ensureRepoMenu();
  createOpen.value = true;
}
async function onIssueCreated(payload: { number: string; repoId: string }) {
  if (!selectedId.value) return;
  await store.addItem({
    projectId: selectedId.value,
    kind: "issue",
    repoId: payload.repoId,
    number: payload.number,
  });
}
function openDrawer() {
  omni.value?.close();
  groupOmni.value?.close();
  omniOpen.value = false;
  void ensureRepoMenu();
  drawerOpen.value = true;
}
/** omnibar 点选 Issue → 以引用条目加入；泳道维度激活时落入对应分组。 */
async function onOmnibarIssue(payload: { repoId: string; number: string }, groupId?: string) {
  if (!selectedId.value) return;
  const created = await store.addItem({
    projectId: selectedId.value,
    kind: "issue",
    repoId: payload.repoId,
    number: payload.number,
  });
  if (created && groupId && store.swimlaneField) {
    await store.setFieldValue(created.id, store.swimlaneField.id, groupId);
  }
}

// ---- 初始滚动：今天入画（平台同款；字段加载完成后再滚）。
// todayIndex 是表头序列的索引，条目列要减去字段列上方的 k 天 ----
async function scrollTodayIntoView() {
  await nextTick();
  const i = todayIndex.value - kDays.value;
  if (i < 0 || !scrollEl.value) return;
  scrollEl.value.scrollLeft = Math.max(0, i * dayWidth.value - dayWidth.value * 2);
}
watch([activeDateField, scrollEl], () => {
  if (activeDateField.value) void scrollTodayIntoView();
});
onMounted(() => {
  updateView();
  window.addEventListener("resize", updateView);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", updateView);
  window.clearTimeout(viewTimer);
});

function onMarkersClick() {
  pushToast({ kind: "info", message: t("roadmap.markersTodo") });
}
</script>

<template>
  <div class="rm">
    <!-- 工具栏（平台右对齐：Markers / Sort / Date fields / Month / Today / ‹ ›） -->
    <div class="rm-toolbar">
      <button class="rm-tbtn" :title="t('roadmap.markers')" @click="onMarkersClick">
        <EditorIcon name="o.location" />
        <span>{{ t("roadmap.markers") }}</span>
      </button>
      <DropdownMenu
        class="rm-dd"
        :options="sortOptions"
        :model-value="store.view.sortBy"
        @update:model-value="store.setSortBy($event as never)"
      >
        <template #trigger="{ toggle }">
          <button class="rm-tbtn" @click="toggle">
            <EditorIcon name="o.arrow-both" class="rm-sort-rot" />
            <span>{{ t("roadmap.sort") }}</span>
          </button>
        </template>
      </DropdownMenu>
      <DropdownMenu
        class="rm-dd"
        :options="dateFields.map((f) => ({ value: f.id, label: f.name }))"
        :model-value="activeDateField?.id ?? ''"
        @update:model-value="dateFieldId = $event as string"
      >
        <template #trigger="{ toggle }">
          <button class="rm-tbtn" @click="toggle">
            <EditorIcon name="o.calendar" />
            <span>{{ t("roadmap.dateFields") }}</span>
          </button>
        </template>
      </DropdownMenu>
      <button class="rm-tbtn" @click="zoom = zoom === 'month' ? 'week' : 'month'">
        <EditorIcon name="o.zoom-in" />
        <span>{{ zoom === "month" ? t("roadmap.zoomMonth") : t("roadmap.zoomWeek") }}</span>
      </button>
      <button class="rm-tbtn" @click="goToday">{{ t("roadmap.today") }}</button>
      <button class="rm-tbtn" :title="t('roadmap.prev')" @click="shiftRange(-1)">‹</button>
      <button class="rm-tbtn" :title="t('roadmap.next')" @click="shiftRange(1)">›</button>
    </div>

    <p v-if="!activeDateField" class="rm-empty">{{ t("roadmap.noDateField") }}</p>

    <!-- 时间轴双向无限：滚动近边缘自动扩充日期；左字段列吸附、表头吸顶 -->
    <div v-else ref="scrollEl" class="rm-scroll" @scroll="onScroll">
      <div
        class="rm-canvas"
        :style="{ width: fieldW + gridWidth + 'px', '--field-w': fieldW + 'px' }"
      >
        <!-- 表头（吸顶层）：月标签 + 日号横贯全宽（字段列上方也是日期刻度，
             平台同款），纯流式 flex（WebKit 对 sticky 容器内 absolute 子有
             绘制丢失案例）。手柄 sticky 钉在字段列右缘 = 日界 -->
        <div class="rm-head">
          <div class="rm-months">
            <!-- 每月一个定位盒：标签在盒内 sticky（左缘 20px）——
                 当月 1 号滚出后标签钉在表头最左，下月 1 号到来把它推走 -->
            <span
              v-for="m in months"
              :key="m.key"
              class="rm-monthbox"
              :style="{ width: m.span * dayWidth + 'px' }"
            >
              <span class="rm-month">{{ m.label }}</span>
            </span>
          </div>
          <div class="rm-days">
            <!-- 手柄必须是最早的流内位置（行首）：sticky 只能把元素"推到"
                 left 界线处、不能从右侧拉回——放行尾会被推到画布末端不可见 -->
            <span
              class="rm-resize"
              :title="t('roadmap.resizeHint')"
              @pointerdown="beginFieldDrag"
              @pointermove="onFieldDragMove"
              @pointerup="endFieldDrag"
            >
              <EditorIcon name="o.unfold" />
            </span>
            <span
              v-for="(d, i) in days"
              :key="d.toISOString()"
              class="rm-day"
              :class="{ today: i === todayIndex }"
              :style="{ width: dayWidth + 'px' }"
            >
              {{ d.getDate() }}
              <span v-if="i === todayIndex" class="rm-todaydot"></span>
            </span>
          </div>
        </div>
        <!-- 网格背景层：整个时间轴区统一灰底（--bg-app = #f6f8fa，平台实测），
             每 7 天一条周线；全列高一次渲染 -->
        <div class="rm-gridlayer" :style="{ left: fieldW + 'px', width: gridWidth + 'px' }">
          <div
            v-for="(d, i) in trackDays"
            :key="d.toISOString()"
            class="rm-cell"
            :class="{ week: d.getDay() === 1 }"
            :style="{ left: i * dayWidth + 'px', width: dayWidth + 'px' }"
          ></div>
        </div>
        <!-- 泳道维度（如优先级）激活：按选项分组渲染，组间 12px 灰底间隙、
             组头带折叠/计数/汇总（与 Table 分组同机制）。
             整个条目区包一层 relative（rm-lanes）：今日红线以其为参照，
             恰好止于内容底（不越过收口线/灰带——红线过长曾被要求修正） -->
        <div class="rm-lanes">
        <template v-for="(g, gi) in roadmapGroups" :key="g.id">
          <div v-if="swimGrouped" class="rm-grouprow" :class="{ gap: gi > 0 }">
            <div class="rm-grouphead" :style="{ width: fieldW + 'px' }">
              <button
                class="rm-groupcollapse"
                :title="store.isLaneCollapsed(g.id) ? t('project.expandLane') : t('project.collapseLane')"
                @click="store.toggleLaneCollapsed(g.id)"
              >
                <EditorIcon :name="store.isLaneCollapsed(g.id) ? 'chevron' : 'o.chevron-down'" />
              </button>
              <span v-if="g.color" class="rm-groupdot" :style="{ background: g.color }"></span>
              <span class="rm-groupname">{{ g.name }}</span>
              <span class="rm-groupcount">{{ g.items.length }}</span>
              <span v-for="s in store.laneSums(g.id)" :key="s.label" class="rm-groupsum">
                {{ s.label }}: {{ s.value }}
              </span>
            </div>
            <div class="rm-groupband"></div>
          </div>
          <!-- 条目行：字段格（吸附左）+ 白色卡片条 -->
          <div
            v-for="(item, idx) in g.items"
            v-show="!store.isLaneCollapsed(g.id)"
            :key="item.id"
            class="rm-row"
          >
            <div class="rm-field" :style="{ width: fieldW + 'px' }">
              <span class="rm-numwrap">
                <ActionMenu
                  class="rm-rowmenu"
                  trigger-icon="chevron"
                  open-on-hover
                  align="left"
                  :menu-width="280"
                  :menu-row-height="40"
                  :title="t('project.actItemMenu')"
                  :items="rowMenuItems(item)"
                  @pick="onRowMenuPick(item, $event)"
                />
                <span class="rm-num">{{ g.start + idx + 1 }}</span>
              </span>
              <EditorIcon
                v-if="item.kind !== 'draft' && item.entity"
                class="rm-state"
                :name="item.kind === 'pull' ? 'pull' : (item.entity?.state ?? '').toUpperCase() === 'CLOSED' ? 'o.issue-closed' : 'o.issue-opened'"
                :style="{ color: (item.entity?.state ?? '').toUpperCase() === 'CLOSED' || (item.entity?.state ?? '').toUpperCase() === 'MERGED' ? 'var(--merged)' : 'var(--success)' }"
              />
              <span class="rm-title" :class="{ ghosty: item.ghost }">{{ itemTitle(item) }}</span>
              <span v-if="item.number" class="rm-ref">#{{ item.number }}</span>
              <span class="rm-flex"></span>
            </div>
          <!-- 时间条 = 平台的白色卡片（状态图标 + 标题 + 灰 #编号 + 右端头像）。
               barwrap 从字段列右缘起（canvas 坐标），条内 left = 时间轴局部偏移；
               沟槽位（紧贴字段列缘）：无日期条目 = ＋（写入今天）、
               卡片滚出左界 = ←（跳回卡片）、滚出右界 = → -->
          <div
            class="rm-barwrap"
            :style="{ left: fieldW + 'px', width: gridWidth + 'px' }"
          >
            <button
              v-if="!dateOf(item) && !item.ghost"
              class="rm-jump is-left"
              :title="addToTodayTip"
              @click.stop="addToToday(item)"
            >
              <EditorIcon name="o.plus" />
            </button>
            <button
              v-if="isOffLeft(item)"
              class="rm-jump is-left"
              :title="t('roadmap.jumpToItem')"
              @click.stop="jumpTo(item)"
            >
              <EditorIcon name="o.arrow-left" />
            </button>
            <button
              v-if="isOffRight(item)"
              class="rm-jump is-right"
              :title="t('roadmap.jumpToItem')"
              @click.stop="jumpTo(item)"
            >
              <EditorIcon name="o.arrow-right" />
            </button>
            <span
              class="rm-bar"
              :style="{ ...(barStyle(item) ?? {}), transform: `translate(${dragOffset(item)}px, -50%)` }"
              @pointerdown="beginDrag(item, 'move', $event)"
              @pointermove="onDragMove"
              @pointerup="endDrag(item)"
            >
              <EditorIcon
                v-if="item.entity"
                class="rm-bar-state"
                :name="item.kind === 'pull' ? 'pull' : (item.entity?.state ?? '').toUpperCase() === 'CLOSED' ? 'o.issue-closed' : 'o.issue-opened'"
                :style="{ color: (item.entity?.state ?? '').toUpperCase() === 'CLOSED' || (item.entity?.state ?? '').toUpperCase() === 'MERGED' ? 'var(--merged)' : 'var(--success)' }"
              />
              <span class="rm-bar-title">{{ itemTitle(item) }}</span>
              <span v-if="item.number" class="rm-bar-ref">#{{ item.number }}</span>
              <img
                v-if="item.entity?.assignees?.[0]"
                class="rm-bar-avatar"
                :src="`https://github.com/${item.entity.assignees[0]}.png?size=40`"
                alt=""
              />
              <span class="rm-handle left" @pointerdown.stop="beginDrag(item, 'start', $event)"></span>
              <span class="rm-handle right" @pointerdown.stop="beginDrag(item, 'end', $event)"></span>
            </span>
          </div>
          </div>
          <!-- 组内 Add item 行（平台：每组独立添加，落入该组；折叠组不渲染，
               与 Table 分组同机制；共享底行仅扁平模式保留） -->
          <div
            v-if="swimGrouped && !store.isLaneCollapsed(g.id)"
            class="rm-addrow"
            :style="{ width: fieldW + 'px' }"
            @click="addingGroup !== g.id && startGroupAdd(g.id)"
          >
            <button v-if="addingGroup !== g.id" type="button" class="rm-additem">
              <EditorIcon name="o.plus" />
              <span>{{ t("project.addItemRow") }}</span>
            </button>
            <ProjectOmnibar
              v-else
              :ref="setGroupOmni"
              inline
              @create-draft="(t) => submitAdd(t, g.id)"
              @open-create-dialog="openCreateDialog"
              @add-from-repo="openDrawer"
              @create-issue="(p) => onOmnibarIssue(p, g.id)"
              @close="addingGroup = null"
            />
          </div>
          </template>
        <!-- 字段列底部 Add item 行（吸附左；共享 omnibar）——仅扁平模式 -->
        <div v-if="!swimGrouped" class="rm-addrow" :style="{ width: fieldW + 'px' }">
          <button v-if="!omniOpen" type="button" class="rm-additem" @click="openAdd">
            <EditorIcon name="o.plus" />
            <span>{{ t("project.addItemRow") }}</span>
          </button>
          <ProjectOmnibar
            v-else
            ref="omni"
            inline
            @create-draft="submitAdd"
            @open-create-dialog="openCreateDialog"
            @add-from-repo="openDrawer"
            @create-issue="onOmnibarIssue"
            @close="omniOpen = false"
          />
        </div>
        <!-- 今日红线：表头红点的垂直延续，止于条目区底（不越过收口线/灰带）。
             以 rm-lanes（relative）为参照；z1 高于灰底网格、低于条目行（z2） -->
        <div
          v-if="todayIndex >= 0"
          class="rm-todayline"
          :style="{ left: fieldW + (todayIndex - kDays) * dayWidth + dayWidth / 2 - 0.5 + 'px' }"
        ></div>
        </div>
        <!-- 字段列收尾条：右边框与白底延伸到窗口底（平台同款） -->
        <!-- 表格收口线：Add item 行下的整行宽 border（平台同款），之后灰带铺到底 -->
        <div class="rm-tableend"></div>
        <!-- 底部灰带：整行宽统一灰底延伸到窗口底（平台同款） -->
        <div class="rm-filler"></div>
      </div>
    </div>

    <!-- omnibar 两条完整路径的容器 -->
    <IssueCreateDialog
      :open="createOpen"
      :repo-options="repoMenu"
      :initial-repo-id="repoMenu[0]?.value"
      :project-label="store.selected?.displayName ?? ''"
      @created="onIssueCreated"
      @close="createOpen = false"
    />
    <ProjectAddItemsDrawer
      :open="drawerOpen"
      :repos="repoMenu"
      :default-repo-id="repoMenu[0]?.value"
      @close="drawerOpen = false"
    />
  </div>
</template>

<style scoped>
.rm {
  position: relative; /* 工具栏吸附层的定位上下文 */
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
/* 工具栏：覆盖在月标签行右端的吸附层（平台同款——月标签与「标记」同行，
   标签随时间轴滚动、滑到「标记」图标处被不透明底遮住进入隐藏） */
.rm-toolbar {
  position: absolute;
  top: 0;
  right: 10px;
  z-index: 8;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  height: 40px;
  padding-left: 16px;
  background: var(--bg-panel);
  font-size: var(--font-md);
  color: var(--text-dim);
}
.rm-tbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  font-family: inherit;
  cursor: pointer;
}
.rm-tbtn:hover {
  background: var(--bg-hover);
}
/* Sort 图标：⇔ 旋转 90° = ⇅（平台排序按钮的上下双箭头形态） */
.rm-sort-rot {
  transform: rotate(90deg);
}
.rm-dd {
  min-width: 0;
}
/* 时间轴滚动容器：垂直 + 水平都滚（平台：左列吸附、表头吸顶） */
.rm-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.rm-canvas {
  position: relative;
  /* 至少撑满滚动视口：条目少时日格底纹也要铺到窗口底（平台同款）；
     flex 列 + 末尾收尾条：字段列右侧的边框与白底延伸到窗口底 */
  min-height: 100%;
  display: flex;
  flex-direction: column;
}
/* 表头（吸顶层）：横贯全宽（字段列上方也是日期刻度），层级低于字段列——
   水平滚动后由吸附的字段列盖住左段（平台同款） */
.rm-head {
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-panel);
  /* 表头是 UI 刻度不是内容：拖拽手柄时不得触发原生文本选择 */
  user-select: none;
  -webkit-user-select: none;
}
.rm-months,
.rm-days {
  display: flex;
  align-items: stretch;
}
.rm-months {
  height: 40px;
}
.rm-days {
  height: 32px;
  border-bottom: 1px solid var(--border);
}
/* 手柄：sticky 钉在字段列右缘（= 日界，列宽按整天吸附），居中于界线；
   平台形态 = ⇔ 图标 + 悬停提示「拖拽调整表格列宽」 */
.rm-resize {
  position: sticky;
  left: calc(var(--field-w) - 14px);
  z-index: 3;
  flex: none;
  width: 28px;
  margin-right: -28px; /* 不占布局宽，日号序列从画布 x=0 连续排布 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-dim);
  cursor: col-resize;
}
/* unfold 图标旋转 90°：上下展开箭头转为左右拖拽向（平台 ⇔ 形态） */
.rm-resize .editor-icon {
  transform: rotate(90deg);
}
.rm-resize:hover {
  color: var(--text);
  background: var(--bg-hover);
}
/* 月盒：占当月天数宽；标签在盒内 sticky（左缘 20px）——默认锚在当月 1 号，
   1 号滚出左缘后钉在表头最左（平台红框位），下月 1 号推走恢复正常滚动 */
.rm-monthbox {
  position: relative;
  flex: none;
  height: 100%;
}
.rm-month {
  position: sticky;
  left: 20px;
  display: inline-block;
  line-height: 40px;
  font-size: var(--font-md);
  font-weight: 400;
  color: var(--text);
  white-space: nowrap;
}
.rm-day {
  position: relative;
  flex: none;
  line-height: 32px;
  text-align: center;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 今日：日号红色 + 数字下方红点 + 红线垂直贯穿时间轴（平台形态） */
.rm-day.today {
  color: var(--danger);
  font-weight: 600;
}
.rm-todaydot {
  position: absolute;
  left: 50%;
  bottom: 1px;
  width: 6px;
  height: 6px;
  margin-left: -3px;
  border-radius: 50%;
  background: var(--danger);
}
/* 条目区容器：relative 供今日红线参照——红线 top:0→bottom:0 恰好从表头红点
   到最后一行/添加行底，不越过收口线与灰带（红线过长曾被要求修正）。
   flex:none：禁收缩，防容器过矮时压扁行（flex-shrink 教训） */
.rm-lanes {
  position: relative;
  flex: none;
}
/* 今日红线：半透明红 1px；上接表头红点，下到条目区底。
   层序：灰底网格 z0 < 本线 z1 < 条目行 z2（红线从卡片背后穿过，平台同款） */
.rm-todayline {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  z-index: 1;
  background: color-mix(in srgb, var(--danger) 30%, transparent);
}
/* 网格背景层：整个时间轴区统一灰底（--bg-app = #f6f8fa 平台实测同源），
   每 7 天一条周线；行下方直到窗口底同样铺满 */
.rm-gridlayer {
  position: absolute;
  top: 72px;
  bottom: 0;
  z-index: 0;
  background: var(--bg-app);
}
.rm-cell {
  position: absolute;
  top: 0;
  bottom: 0;
}
.rm-cell.week::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border);
}
/* 条目行：40px；字段格吸附左、有行线；时间轴无行线。
   z2：高于今日红线（z1）——红线从卡片背后穿过 */
.rm-row {
  position: relative;
  z-index: 2;
  display: flex;
  height: 40px;
}
/* 泳道组头（平台 Group by 行）：白底横贯、折叠/色点/名称/计数/汇总；
   组间 12px 灰底间隙（折叠后同样保留） */
.rm-grouprow {
  position: relative;
  display: flex;
  height: 40px;
}
.rm-grouprow.gap {
  margin-top: 12px;
}
.rm-grouphead {
  position: sticky;
  left: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 20px;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  min-width: 0;
}
.rm-groupcollapse {
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  color: var(--text-dim);
  padding: 2px;
  border-radius: 5px;
  cursor: pointer;
}
.rm-groupcollapse:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.rm-groupdot {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
}
.rm-groupname {
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.rm-groupcount {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 2px 6px;
  border-radius: 20px;
  background: #818b981f;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.rm-groupsum {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 9999px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.rm-groupband {
  flex: none;
  width: 0;
}
/* 悬停行整体提层：行菜单（行内 absolute 后代）必须盖住后续行的
   不透明字段列（同为 z3，DOM 靠后者会盖住前行菜单） */
.rm-row:hover {
  z-index: 7;
}
.rm-field {
  position: sticky;
  left: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 12px;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  min-width: 0;
}
/* 字段格前段三件套：▾ 槽（固定 24，右对齐）+ 行号（固定 20，居中）+ 8px 内容间隙，
   之后才是状态图标/标题（平台截图几何：▾ 左贴边、行号居中、与 ✓ 间隙明显） */
.rm-numwrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: none;
  width: 44px;
}
.rm-num {
  flex: 1;
  text-align: center;
  color: var(--text-dim);
  font-size: var(--font-md);
}
/* 悬停行：▾ 显示在行号左侧（平台形态：▾ + 行号并排，行号不隐藏） */
.rm-rowmenu {
  display: none;
  flex: none;
  width: 24px;
  justify-content: flex-end;
  margin-left: -4px; /* ▾ 槽贴字段列左缘（与格 padding 12 抵消后视觉贴边） */
}
.rm-row:hover .rm-rowmenu {
  display: inline-flex;
}
.rm-state {
  flex: none;
  display: inline-flex;
}
.rm-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-base);
  color: var(--text);
}
.rm-title.ghosty {
  color: var(--text-dim);
}
.rm-ref {
  flex: none;
  color: var(--text-dim);
  font-size: var(--font-md);
}
.rm-flex {
  flex: 1;
}
/* 日期条 = 平台的白色卡片（状态图标 + 标题 + 灰色 #编号 + 右端头像），
   白底描边圆角带阴影，浮在时间轴上；宽 = 起止跨度，内容更宽时按内容兜底。
   barwrap 定位由模板内联给出（left = 字段列宽）；越界跳转箭头 sticky 钉边 */
.rm-barwrap {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: flex-start;
  pointer-events: none;
}
/* 卡片滚出可视时间轴时的跳转箭头：左出钉在字段列右缘、右出钉在视口右缘 */
.rm-jump {
  pointer-events: auto;
  position: sticky;
  top: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  margin: 6px 0 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  color: var(--text-dim);
  cursor: pointer;
  z-index: 2;
}
.rm-jump:hover {
  color: var(--text);
  background: var(--bg-hover);
}
/* 沟槽位按钮（← / ＋）紧贴字段列缘（8px 间距，平台同款）；
   → 钉在视口右缘，同样留 8px 对称间距 */
.rm-jump.is-left {
  left: calc(var(--field-w) + 8px);
}
.rm-jump.is-right {
  right: 8px;
  margin-left: auto;
}
.rm-bar {
  pointer-events: auto;
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  cursor: grab;
  /* 平台同款：卡片不小于内容宽（只有开始日期的条目也显示完整标题） */
  min-width: max-content;
}
.rm-bar-state {
  flex: none;
  display: inline-flex;
}
.rm-bar-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-base);
  color: var(--text);
}
.rm-bar-ref {
  flex: none;
  color: var(--text-dim);
  font-size: var(--font-md);
}
.rm-bar-avatar {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  margin-left: auto;
}
/* 拖拽手柄（两端改起止） */
.rm-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
}
.rm-handle.left {
  left: -2px;
}
.rm-handle.right {
  right: -2px;
}
/* 字段列底部 Add item 行（吸附左；共享 omnibar） */
.rm-addrow {
  position: sticky;
  left: 0;
  z-index: 3;
  flex: none;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
  /* 平台：Add item 行下不再画线，字段列白底与右边框继续延伸到窗口底 */
  min-height: 34px;
}
/* 字段列收尾条：撑满 Add item 之下的剩余高度（右边框贯穿到底，平台同款） */
/* 底部灰带：Add item 之下整行宽（含字段列区域）统一灰底到窗口底。
   z1 高于网格层——全宽横线以下的周线/刻度一律不显示（平台同款） */
.rm-filler {
  position: relative;
  z-index: 1;
  flex: 1 1 auto;
  background: var(--bg-app);
}
/* 表格收口线：Add item 行下的整行宽 border。
   必须 relative + z2：灰带层是 absolute z0，静态元素会被它盖住（实测丢失） */
.rm-tableend {
  position: relative;
  z-index: 2;
  flex: none;
  height: 1px;
  background: var(--border);
}
.rm-additem {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 34px;
  padding: 0 12px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-base);
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}
.rm-additem:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.rm-empty {
  margin: 12px;
  font-size: var(--font-md);
  color: var(--text-dim);
}
</style>
