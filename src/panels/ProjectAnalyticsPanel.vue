<script setup lang="ts">
/**
 * 项目分析 Editor（「项目」工作区分组）——《架构设计-Projects本地看板》Q9 报表的 v1。
 *
 * 形态依据 Q9：**燃起优先于燃尽**（scope 变化看得见，比燃尽更诚实）、**计数制**、
 * **自绘 SVG**（与 git 泳道图同传统，不引图表库）。
 *
 * 数据的两条腿（**诚实边界**，页面里也如实标注）：
 * - **趋势**（燃起图）：来自 app_017 的每日计数快照——只能"从开始记录那天起"；
 *   平台镜像拿不到列间流转历史，而本地真源的精确重放要等容器 journal 化（二期）。
 * - **当前分布**：现算（条目 + 字段值的当前状态），不依赖历史。
 */
import { computed, onMounted, ref } from "vue";
import PanelShell from "../workbench/PanelShell.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import { api, isTauri } from "../api";
import { useI18n } from "../i18n";
import { useProjectsStore } from "../stores/projects";
import {
  NO_STATUS,
  axisDays,
  buildStack,
  cumulativeBelow,
  distributionByOption,
  pointX,
  stackBandPath,
  stackBarRects,
  valueY,
  type SnapshotRow,
} from "./analytics-model";

defineProps<{ leafId?: string; panelType?: string }>();

const { t } = useI18n();
const store = useProjectsStore();

/** 趋势窗口（天）：默认 30，可切 7 / 30 / 90。 */
const windowDays = ref(30);
const snapshots = ref<SnapshotRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

onMounted(() => void load());

async function load(): Promise<void> {
  if (!isTauri() || !store.selectedId) return;
  loading.value = true;
  error.value = null;
  try {
    // 打开分析面时刷新当天快照：用户看到的当天值就是"到此刻为止"
    await store.takeSnapshot(true);
    snapshots.value = (await api.projectSnapshotList(store.selectedId, windowDays.value)) as SnapshotRow[];
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function setWindow(days: number): Promise<void> {
  windowDays.value = days;
  await load();
}

const windowChoices = computed(() => [
  { value: "7", label: t("analytics.days", { n: 7 }) },
  { value: "30", label: t("analytics.days", { n: 30 }) },
  { value: "90", label: t("analytics.days", { n: 90 }) },
]);

// ---- 当前状态（分布与概览都基于它，不依赖历史）----
const statusField = computed(() => store.fields.find((f) => f.kind === "builtin_status") ?? null);
/** 状态选项顺序 = 看板列顺序（左起"未开始"、末尾"已完成"）——概览卡与堆叠顺序都用它。 */
const statusOptions = computed(() => statusField.value?.options ?? []);

/** 今天的本地日（快照以本地日为准；与 Rust 侧 now_iso 同口径）。 */
const todayIso = computed(() => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
});

/** 连续日轴 = 窗口本身（今天在右端）：空区域因此有明确范围，"哪几天没记录"一目了然。 */
const axis = computed(() => axisDays(todayIso.value, windowDays.value));

const stack = computed(() =>
  buildStack(
    snapshots.value,
    statusOptions.value.map((o) => o.id),
    axis.value,
  ),
);

const latest = computed(() => snapshots.value.at(-1) ?? null);
const optionById = computed(() => new Map(statusOptions.value.map((o) => [o.id, o])));
/** 堆叠档的配色：列选项色；`__none__`（草稿/未落列）用中性色。 */
function colorOf(key: string): string {
  if (key === NO_STATUS) return "var(--text-dim)";
  return optionById.value.get(key)?.color ?? "var(--border)";
}
function labelOf(key: string): string {
  if (key === NO_STATUS) return t("analytics.noStatus");
  return optionById.value.get(key)?.name ?? key;
}

/** 概览：总数 / 已完成（末列）/ 未开始（首列）/ 进行中（其余）。 */
const overview = computed(() => {
  const s = latest.value?.status ?? {};
  const opts = statusOptions.value;
  if (opts.length === 0) return { total: latest.value?.total ?? 0, done: 0, todo: 0, doing: 0 };
  const done = s[opts[opts.length - 1].id] ?? 0;
  const todo = s[opts[0].id] ?? 0;
  const total = latest.value?.total ?? 0;
  return { total, done, todo, doing: Math.max(0, total - done - todo) };
});

// ---- 当前分布（柱状）：状态 + 第一个单选字段（通常是优先级）----
const groupField = computed(() => store.fields.find((f) => f.kind === "single_select") ?? null);
const statusBars = computed(() =>
  distributionByOption(
    store.items.map((i) => ({ itemId: i.id, value: i.fieldValues[statusField.value?.id ?? ""] ?? null })),
    statusOptions.value,
  ),
);
const groupBars = computed(() => {
  const field = groupField.value;
  if (!field) return [];
  return distributionByOption(
    store.items.map((i) => ({ itemId: i.id, value: i.fieldValues[field.id] ?? null })),
    field.options,
  );
});
function barWidth(count: number, bars: { count: number }[]): string {
  const max = Math.max(1, ...bars.map((b) => b.count));
  return `${Math.round((count / max) * 100)}%`;
}

// ---- SVG 画布（自绘：坐标来自 analytics-model 的纯函数）----
const CHART = { width: 640, height: 200, padTop: 14, padBottom: 22, padLeft: 30, padRight: 14 };
const axisLen = computed(() => Math.max(1, stack.value.axis.length));
const xOf = (index: number): number => pointX(index, axisLen.value, CHART.width, CHART.padLeft, CHART.padRight);
/** 单日柱的半宽（窗口 30 天时一格约 20px，取 5 保证不糊成一条线）。 */
const BAR_HALF = 5;

/** 面积带：**按连续记录段**画（段间不连线——中间那些天没记录，连起来等于编造）。 */
const bandPaths = computed(() =>
  stack.value.series.flatMap((s, i) =>
    stack.value.spans
      .filter((span) => span.length >= 2)
      .map((span) => ({
        key: `${s.key}:${span[0]}`,
        label: s.label,
        color: colorOf(s.key),
        d: stackBandPath(s.values, cumulativeBelow(stack.value.series, i), span, {
          ...CHART,
          max: stack.value.max,
          axisLength: axisLen.value,
        }),
      })),
  ),
);

/** 只有一天记录的段 → 当日柱（面积路径零宽，什么都看不见；这是"单点也可见"的关键）。 */
interface DayBar {
  key: string;
  x: number;
  color: string;
  label: string;
  rects: { key: string; y: number; h: number }[];
  total: number;
}
const dayBars = computed<DayBar[]>(() =>
  stack.value.spans
    .filter((span) => span.length === 1)
    .map((span) => {
      const i = span[0];
      const rects = stack.value.series.map((s, k) => {
        const below = cumulativeBelow(stack.value.series, k)[i] ?? 0;
        const seriesOnly = { ...s, values: [s.values[i]] } as typeof s;
        const [r] = stackBarRects([seriesOnly], [below], { ...CHART, max: stack.value.max });
        return r ?? { key: s.key, y: CHART.height, h: 0 };
      });
      const day = stack.value.axis[i];
      const row = snapshots.value.find((r) => r.day === day);
      return {
        key: day,
        x: xOf(i),
        color: "var(--text)",
        label: day,
        rects: rects.map((r, k) => ({ ...r, key: stack.value.series[k].key })),
        total: row?.total ?? 0,
      };
    }),
);

/** 总量折线：同样按段画（段内相邻点连线）。 */
const totalPaths = computed(() =>
  stack.value.spans
    .filter((span) => span.length >= 2)
    .map((span) => ({
      key: `total:${span[0]}`,
      d: span
        .map((i, k) => {
          const total = stack.value.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0);
          const x = xOf(i).toFixed(1);
          const y = valueY(total, stack.value.max, CHART.height, CHART.padTop, CHART.padBottom).toFixed(1);
          return `${k === 0 ? "M" : "L"}${x},${y}`;
        })
        .join(" "),
    })),
);

/** 记录起点标记（第一条记录的 x）：空区域里明确"从哪儿开始有数据"。 */
const firstRecordX = computed(() =>
  stack.value.recorded.length ? xOf(stack.value.recorded[0]) : null,
);

/** y 轴刻度（0 / 中 / 上限）。 */
const yTicks = computed(() =>
  [0, Math.round(stack.value.max / 2), stack.value.max].map((v) => ({
    v,
    y: valueY(v, stack.value.max, CHART.height, CHART.padTop, CHART.padBottom).toFixed(1),
  })),
);

/** x 轴刻度：**窗口**的首/中/尾（不是数据的首尾——空白区也要有范围感）。 */
const xLabels = computed(() => {
  const days = stack.value.axis;
  if (days.length === 0) return [];
  const picks =
    days.length <= 2 ? days.map((_, i) => i) : [0, Math.floor((days.length - 1) / 2), days.length - 1];
  return picks.map((i) => ({ day: days[i], x: xOf(i).toFixed(1) }));
});
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template #actions>
      <DropdownMenu
        class="an-window"
        :options="windowChoices"
        :model-value="String(windowDays)"
        @update:model-value="setWindow(Number($event))"
      />
    </template>

    <div class="an-wrap">
      <p v-if="!store.selected" class="an-empty">{{ t("analytics.noProject") }}</p>
      <template v-else>
        <!-- 概览（当前状态；不依赖历史） -->
        <div class="an-cards">
          <div class="an-card">
            <span class="an-card-num">{{ overview.total }}</span>
            <span class="an-card-label">{{ t("analytics.cardTotal") }}</span>
          </div>
          <div class="an-card">
            <span class="an-card-num">{{ overview.todo }}</span>
            <span class="an-card-label">{{ t("analytics.cardTodo") }}</span>
          </div>
          <div class="an-card">
            <span class="an-card-num">{{ overview.doing }}</span>
            <span class="an-card-label">{{ t("analytics.cardDoing") }}</span>
          </div>
          <div class="an-card">
            <span class="an-card-num">{{ overview.done }}</span>
            <span class="an-card-label">{{ t("analytics.cardDone") }}</span>
          </div>
        </div>

        <!-- 燃起图（按天 × 状态堆叠 + 总量折线） -->
        <h3 class="an-title">{{ t("analytics.burnUp") }}</h3>
        <p class="an-note">{{ t("analytics.burnUpHint") }}</p>
        <div v-if="stack.recorded.length === 0" class="an-empty">
          {{ loading ? t("common.loading") : t("analytics.noHistory") }}
        </div>
        <div v-else class="an-chart">
          <svg :viewBox="`0 0 ${CHART.width} ${CHART.height}`" preserveAspectRatio="none" role="img"
               :aria-label="t('analytics.burnUp')">
            <line v-for="tick in yTicks" :key="tick.v" class="an-grid"
                  :x1="CHART.padLeft" :x2="CHART.width - CHART.padRight" :y1="tick.y" :y2="tick.y" />
            <!-- 记录起点：空区域里明确"从哪天起有数据" -->
            <line v-if="firstRecordX !== null" class="an-start"
                  :x1="firstRecordX" :x2="firstRecordX" :y1="CHART.padTop" :y2="CHART.height - CHART.padBottom" />
            <path v-for="band in bandPaths" :key="band.key" :d="band.d" :fill="band.color" opacity="0.85" />
            <!-- 单日段画成当日柱（面积零宽看不见） -->
            <g v-for="bar in dayBars" :key="bar.key">
              <rect v-for="r in bar.rects" :key="r.key" :x="bar.x - BAR_HALF" :width="BAR_HALF * 2"
                    :y="r.y" :height="r.h" :fill="colorOf(r.key)" opacity="0.85" />
              <text class="an-bar-total" :x="bar.x" :y="Math.max(10, Number(bar.rects[0]?.y ?? 10) - 4)"
                    text-anchor="middle">{{ bar.total }}</text>
            </g>
            <path v-for="p in totalPaths" :key="p.key" class="an-total" :d="p.d" />
          </svg>
          <div class="an-axis">
            <span v-for="tick in yTicks" :key="tick.v" class="an-ytick" :style="{ top: `${(Number(tick.y) / CHART.height) * 100}%` }">
              {{ tick.v }}
            </span>
          </div>
        </div>
        <div v-if="stack.recorded.length" class="an-xaxis">
          <span v-for="l in xLabels" :key="l.day" class="an-xlabel">{{ l.day.slice(5) }}</span>
        </div>
        <div v-if="stack.series.length" class="an-legend">
          <span v-for="band in bandPaths" :key="band.key" class="an-legend-item">
            <i class="an-dot" :style="{ background: band.color }"></i>{{ labelOf(band.key) }}
          </span>
        </div>
        <p class="an-note">{{ t("analytics.axisHint") }}</p>
        <p v-if="stack.recorded.length <= 2" class="an-note">{{ t("analytics.oneDayOnly") }}</p>
        <p class="an-note">{{ t("analytics.historyBoundary") }}</p>

        <!-- 当前分布 -->
        <h3 class="an-title">{{ t("analytics.distribution") }}</h3>
        <p class="an-note">{{ t("analytics.distributionHint") }}</p>
        <div v-for="bar in statusBars" :key="bar.key" class="an-bar-row">
          <span class="an-bar-label">{{ bar.key === NO_STATUS ? t("analytics.noStatus") : bar.label }}</span>
          <span class="an-bar-track">
            <span class="an-bar-fill" :style="{ width: barWidth(bar.count, statusBars), background: colorOf(bar.key) }"></span>
          </span>
          <span class="an-bar-count">{{ bar.count }}</span>
        </div>
        <template v-if="groupField && groupBars.length">
          <h3 class="an-title an-title-sub">{{ groupField.name }}</h3>
          <div v-for="bar in groupBars" :key="bar.key" class="an-bar-row">
            <span class="an-bar-label">{{ bar.label || t("analytics.noStatus") }}</span>
            <span class="an-bar-track">
              <span class="an-bar-fill" :style="{ width: barWidth(bar.count, groupBars), background: bar.color ?? 'var(--accent)' }"></span>
            </span>
            <span class="an-bar-count">{{ bar.count }}</span>
          </div>
        </template>

        <p v-if="error" class="an-error">{{ error }}</p>
      </template>
    </div>
  </PanelShell>
</template>

<style scoped>
.an-wrap {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px 24px;
}
.an-window {
  width: 96px;
}
.an-cards {
  display: flex;
  gap: 10px;
  margin-bottom: 14px;
}
.an-card {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
}
.an-card-num {
  font-size: var(--font-xl);
  color: var(--text);
}
.an-card-label {
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.an-title {
  margin: 14px 0 2px;
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.an-title-sub {
  margin-top: 12px;
}
.an-note {
  margin: 0 0 8px;
  font-size: var(--font-sm);
  color: var(--text-dim);
  line-height: 1.5;
}
.an-chart {
  position: relative;
  height: 200px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  overflow: hidden;
}
.an-chart svg {
  display: block;
  width: 100%;
  height: 100%;
}
.an-grid {
  stroke: var(--border);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.an-start {
  stroke: var(--border);
  stroke-dasharray: 3 3;
  vector-effect: non-scaling-stroke;
}
.an-bar-total {
  font-size: 10px;
  fill: var(--text);
}
.an-total {
  fill: none;
  stroke: var(--text);
  stroke-width: 1.6;
  vector-effect: non-scaling-stroke;
}
.an-axis {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.an-ytick {
  position: absolute;
  left: 4px;
  transform: translateY(-50%);
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.an-xaxis {
  display: flex;
  justify-content: space-between;
  padding: 3px 6px 0;
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.an-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin-top: 6px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.an-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.an-dot {
  width: 9px;
  height: 9px;
  border-radius: 2px;
  display: inline-block;
}
.an-bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.an-bar-label {
  flex: 0 0 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-md);
  color: var(--text);
}
.an-bar-track {
  flex: 1 1 auto;
  height: 10px;
  border-radius: 3px;
  background: var(--bg-hover);
  overflow: hidden;
}
.an-bar-fill {
  display: block;
  height: 100%;
}
.an-bar-count {
  flex: 0 0 28px;
  text-align: right;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.an-empty {
  margin: 10px 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.an-error {
  margin: 10px 0 0;
  font-size: var(--font-sm);
  color: var(--danger);
}
</style>
