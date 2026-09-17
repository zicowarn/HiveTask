<script setup lang="ts">
/**
 * Roadmap 布局（对齐平台的 Roadmap view）：
 * 工具栏 [Markers | 排序 | 日期字段 | 缩放 | Today | ‹ ›]，
 * 左侧标题列 + 右侧时间轴（月表头 + 日列），条目按日期字段画横条，
 * 无日期的条目给平台的「Add to today」入口，今天有竖线与标签。
 */
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { useProjectsStore } from "../../stores/projects";
import type { ProjectItem } from "../../api";
import { useI18n } from "../../i18n";
import { itemTitle } from "../item-fields";
import EditorIcon from "../../components/EditorIcon.vue";
import DropdownMenu from "../../components/DropdownMenu.vue";

const store = useProjectsStore();
const { filteredItems, fields } = storeToRefs(store);
const { t } = useI18n();

/** 日期字段候选（kind = date；无则回落到「创建时间」这类镜像时间不可写，故仅列真实字段）。 */
const dateFields = computed(() => fields.value.filter((f) => f.kind === "date"));
const dateFieldId = ref<string>("");
const activeDateField = computed(
  () => dateFields.value.find((f) => f.id === dateFieldId.value) ?? dateFields.value[0] ?? null,
);

const sortOptions = [
  { value: "manual", label: "手动排序" },
  { value: "priority", label: "优先级" },
  { value: "added", label: "添加时间" },
];

const DAY = 86_400_000;
const zoom = ref<"month" | "week">("month");
/** 每档的日宽（px）：月档细、周档宽（平台 Zoom level）。 */
const dayWidth = computed(() => (zoom.value === "month" ? 26 : 56));

const today = new Date();
const anchor = ref(new Date(today.getFullYear(), today.getMonth(), today.getDate()));

function dateOf(item: ProjectItem): Date | null {
  const field = activeDateField.value;
  if (!field) return null;
  const raw = item.fieldValues[field.id];
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 时间窗：有日期时覆盖其范围（前后各留一周），否则今天前后各 30 天。 */
const range = computed(() => {
  const dates = filteredItems.value.map(dateOf).filter((d): d is Date => !!d);
  const from = new Date(anchor.value);
  const to = new Date(anchor.value);
  if (dates.length) {
    const min = new Date(Math.min(...dates.map((d) => d.getTime())));
    const max = new Date(Math.max(...dates.map((d) => d.getTime())));
    from.setTime(Math.min(min.getTime(), anchor.value.getTime()) - 7 * DAY);
    to.setTime(Math.max(max.getTime(), anchor.value.getTime()) + 14 * DAY);
  } else {
    from.setTime(anchor.value.getTime() - 30 * DAY);
    to.setTime(anchor.value.getTime() + 30 * DAY);
  }
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);
  return { from, to };
});

/** 天数与月分组（月表头跨其天数，平台同款）。 */
const days = computed(() => {
  const out: Date[] = [];
  for (let d = new Date(range.value.from); d <= range.value.to; d = new Date(d.getTime() + DAY)) {
    out.push(new Date(d));
  }
  return out;
});
const months = computed(() => {
  const out: { key: string; label: string; span: number }[] = [];
  for (const d of days.value) {
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const last = out[out.length - 1];
    const label = d.toLocaleDateString(undefined, { year: "numeric", month: "long" });
    if (!last || last.key !== key) out.push({ key, label, span: 1 });
    else last.span += 1;
  }
  return out;
});

const endField = computed(
  () => dateFields.value.find((f) => f.id === store.view.dateEndFieldId) ?? null,
);
function endOf(item: ProjectItem): Date | null {
  const field = endField.value;
  if (!field) return null;
  const raw = item.fieldValues[field.id];
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** 条：有结束日期 = 区间条（Start→End），否则单点条。 */
function barStyle(item: ProjectItem): Record<string, string> | null {
  const start = dateOf(item);
  if (!start) return null;
  const end = endOf(item);
  const left = offsetOf(start);
  const width = end && end > start ? offsetOf(end) - left + dayWidth.value : dayWidth.value;
  return { left: left + "px", width: width + "px" };
}

function offsetOf(date: Date): number {
  return ((date.getTime() - range.value.from.getTime()) / DAY) * dayWidth.value;
}
const todayOffset = computed(() => (today >= range.value.from && today <= range.value.to ? offsetOf(today) : null));
const gridWidth = computed(() => days.value.length * dayWidth.value);

// ---- 拖拽改期（平台：拖条体平移、拖两端手柄改起止）----
const drag = ref<{ id: string; mode: "move" | "start" | "end"; startX: number; days: number } | null>(null);

function beginDrag(item: ProjectItem, mode: "move" | "start" | "end", event: PointerEvent) {
  if (!dateOf(item)) return;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  drag.value = { id: item.id, mode, startX: event.clientX, days: 0 };
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
  const shiftIso = (iso: string) => {
    const x = new Date(iso);
    x.setDate(x.getDate() + d.days);
    return x.toISOString().slice(0, 10);
  };
  const startRaw = startField ? item.fieldValues[startField.id] : undefined;
  const endRaw = endFieldRef ? item.fieldValues[endFieldRef.id] : undefined;
  if (startField && startRaw && d.mode !== "end") {
    await store.setFieldValue(item.id, startField.id, shiftIso(startRaw));
  }
  if (endFieldRef && endRaw && d.mode !== "start") {
    await store.setFieldValue(item.id, endFieldRef.id, shiftIso(endRaw));
  }
}
/** 拖拽中的预览位移（px）。 */
function dragOffset(item: ProjectItem): number {
  const d = drag.value;
  if (!d || d.id !== item.id) return 0;
  return d.days * dayWidth.value;
}

/** 无日期的条目 → 平台的「Add to today」。 */
async function addToToday(item: ProjectItem) {
  const field = activeDateField.value;
  if (!field) return;
  const iso = new Date().toISOString().slice(0, 10);
  await store.setFieldValue(item.id, field.id, iso);
}
function shiftRange(dir: -1 | 1) {
  const next = new Date(anchor.value);
  next.setDate(next.getDate() + dir * (zoom.value === "month" ? 30 : 7));
  anchor.value = next;
}
function goToday() {
  anchor.value = new Date(today.getFullYear(), today.getMonth(), today.getDate());
}
</script>

<template>
  <div class="rm">
    <!-- 工具栏（平台 Roadmap：Markers / 排序 / 日期字段 / 缩放 / Today / ‹ ›） -->
    <div class="rm-bar">
      <span class="rm-item">{{ t("roadmap.dateFields") }}</span>
      <DropdownMenu
        class="rm-dd"
        :options="dateFields.map((f) => ({ value: f.id, label: f.name }))"
        :model-value="activeDateField?.id ?? ''"
        @update:model-value="dateFieldId = $event as string"
      />
      <span class="rm-item">{{ t("roadmap.dateEnd") }}</span>
      <DropdownMenu
        class="rm-dd"
        :options="[{ value: '', label: t('project.none') }, ...dateFields.map((f) => ({ value: f.id, label: f.name }))]"
        :model-value="store.view.dateEndFieldId ?? ''"
        @update:model-value="store.setDateEndFieldId(($event as string) || null)"
      />
      <span class="rm-item">{{ t("roadmap.sort") }}</span>
      <DropdownMenu
        class="rm-dd"
        :options="sortOptions"
        :model-value="store.view.sortBy"
        @update:model-value="store.setSortBy($event as never)"
      />
      <button class="rm-btn" @click="zoom = zoom === 'month' ? 'week' : 'month'">
        {{ zoom === "month" ? t("roadmap.zoomMonth") : t("roadmap.zoomWeek") }}
      </button>
      <button class="rm-btn" @click="goToday">{{ t("roadmap.today") }}</button>
      <button class="rm-btn" :title="t('roadmap.prev')" @click="shiftRange(-1)">‹</button>
      <button class="rm-btn" :title="t('roadmap.next')" @click="shiftRange(1)">›</button>
    </div>

    <p v-if="!activeDateField" class="rm-empty">{{ t("roadmap.noDateField") }}</p>

    <div v-else class="rm-grid">
      <!-- 月表头 -->
      <div class="rm-months">
        <div v-for="m in months" :key="m.key" class="rm-month" :style="{ width: m.span * dayWidth + 'px' }">
          {{ m.label }}
        </div>
      </div>
      <!-- 日列头 -->
      <div class="rm-days" :style="{ width: gridWidth + 'px' }">
        <div v-for="d in days" :key="d.toISOString()" class="rm-day" :style="{ width: dayWidth + 'px' }">
          {{ d.getDate() }}
        </div>
      </div>

      <!-- 条目行 -->
      <div class="rm-rows">
        <div v-for="item in filteredItems" :key="item.id" class="rm-row">
          <div class="rm-title">
            <span class="rm-num">{{ item.number ? `#${item.number}` : "" }}</span>
            {{ itemTitle(item) }}
          </div>
          <div class="rm-track" :style="{ width: gridWidth + 'px' }">
            <span
              v-if="todayOffset !== null"
              class="rm-today"
              :style="{ left: todayOffset + 'px' }"
            ></span>
            <span
              v-if="barStyle(item)"
              class="rm-bar"
              :style="{ ...(barStyle(item) ?? {}), transform: `translate(${dragOffset(item)}px, -50%)` }"
              @pointerdown="beginDrag(item, 'move', $event)"
              @pointermove="onDragMove"
              @pointerup="endDrag(item)"
            >
              <span
                class="rm-handle left"
                @pointerdown.stop="beginDrag(item, 'start', $event)"
              ></span>
              <span
                class="rm-handle right"
                @pointerdown.stop="beginDrag(item, 'end', $event)"
              ></span>
            </span>
            <button v-else class="rm-addtoday" @click="addToToday(item)">
              <EditorIcon name="o.plus" />
              {{ t("roadmap.addToToday") }}
            </button>
          </div>
        </div>
        <p v-if="filteredItems.length === 0" class="rm-empty">{{ t("project.noItems") }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rm {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.rm-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-size: var(--font-md);
  color: var(--text-dim);
}
.rm-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.rm-dd {
  min-width: 110px;
}
.rm-select {
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
}
.rm-btn {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  cursor: pointer;
}
.rm-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.rm-grid {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 12px 12px;
}
.rm-months,
.rm-days {
  display: flex;
}
.rm-month,
.rm-day {
  flex: none;
  text-align: center;
  font-size: var(--font-sm);
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
  padding: 4px 0;
}
.rm-month {
  font-weight: 600;
  color: var(--text);
  border-left: 1px solid var(--border);
}
.rm-rows {
  display: flex;
  flex-direction: column;
}
.rm-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  min-height: 34px;
}
.rm-title {
  width: 240px;
  flex: none;
  font-size: var(--font-lg);
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rm-num {
  color: var(--text-dim);
  font-size: var(--font-sm);
  margin-right: 6px;
}
.rm-track {
  position: relative;
  flex: none;
  height: 34px;
}
/* 日期条 + 今天竖线（平台：条为圆角胶囊，今天为竖线） */
/* 拖拽手柄（平台：拖两端改起止） */
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
.rm-bar-pill,
.rm-bar {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  height: 14px;
  border-radius: 7px;
  background: var(--accent);
  cursor: grab;
}
.rm-today {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--accent);
}
.rm-addtoday {
  position: absolute;
  top: 50%;
  left: 0;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  padding: 2px 6px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.rm-addtoday:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.rm-empty {
  margin: 12px;
  font-size: var(--font-md);
  color: var(--text-dim);
}
</style>
