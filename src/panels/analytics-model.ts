/**
 * 项目分析的图表数学（纯函数，无 UI / store 依赖——坐标与堆叠最容易错，单独钉死）。
 *
 * 形态依据《架构设计-Projects本地看板》Q9：**燃起优先于燃尽**（scope 变化可见，
 * 更诚实）、**计数制**、**自绘 SVG**（与 git 泳道图同传统，不引图表库）。
 */

export interface SnapshotRow {
  day: string;
  total: number;
  /** 状态选项 id → 计数。 */
  status: Record<string, number>;
  /** 状态选项 id → 当时的名字。 */
  labels: Record<string, string>;
}

/** 没有状态值的条目（草稿 / 未落列）在图表里的兜底档 key（与 Rust 侧同字面量）。 */
export const NO_STATUS = "__none__";

export interface StackSeries {
  /** 堆叠档（列顺序即堆叠顺序，自下而上）。 */
  key: string;
  label: string;
  /** 与 `axis` 等长的计数；**null = 该日没有记录**（≠ 0——不能把"没打开过应用"画成"当时 0 条"）。 */
  values: (number | null)[];
}

export interface StackChart {
  /** 连续日轴 = 窗口本身（如最近 30 天，今天在右端）。没有它，空白区就没有"范围"可言——
   *  用户看到一大块空白时的第一反应是"这块是什么"，轴要先回答这个问题。 */
  axis: string[];
  /** 轴上有记录的下标（升序）。 */
  recorded: number[];
  series: StackSeries[];
  /** y 轴上限 = 有记录日里的最大总数（0 → 1，避免除零）。 */
  max: number;
  /** 连续记录段（每段一串相邻轴下标）：面积按段画，**段间不连线**——中间那些天没记录，
   *  连起来等于编造。单下标段按"当日柱"画（见 stackBarRects）。 */
  spans: number[][];
}

/** 从 `todayIso`（YYYY-MM-DD）往前数 `days` 天的连续日期（升序，末日 = today）。 */
export function axisDays(todayIso: string, days: number): string[] {
  const n = Math.max(1, Math.floor(days));
  const end = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(end)) return [];
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(new Date(end - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * 快照序列 → 堆叠序列。档位的**先后顺序**由调用方给的 `statusOrder`（列定义顺序，
 * 也就是看板从左到右）决定；快照里出现过、但已不在列定义里的档位（选项被删）
 * 追加在末尾——用快照自带的名字，历史不因删列而消失。
 */
export function buildStack(
  rows: SnapshotRow[],
  statusOrder: string[],
  axis?: string[],
): StackChart {
  const days = axis && axis.length > 0 ? axis : rows.map((r) => r.day);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const known = new Set<string>();
  const seen: string[] = [];
  const labelOf = new Map<string, string>();
  for (const r of rows) {
    for (const [key, n] of Object.entries(r.status)) {
      if (n <= 0) continue;
      if (!labelOf.has(key)) labelOf.set(key, r.labels[key] ?? key);
      if (!known.has(key)) {
        known.add(key);
        seen.push(key);
      }
    }
  }
  const ordered = [
    ...statusOrder.filter((k) => known.has(k)),
    ...seen.filter((k) => !statusOrder.includes(k)),
  ];
  const series: StackSeries[] = ordered.map((key) => ({
    key,
    label: labelOf.get(key) ?? key,
    values: days.map((day) => {
      const row = byDay.get(day);
      return row ? (row.status[key] ?? 0) : null;
    }),
  }));
  const recorded = days.map((day, i) => (byDay.has(day) ? i : -1)).filter((i) => i >= 0);
  // 连续记录段：相邻下标归一段（空档把趋势断开——诚实，也不给"没记录"编数字）
  const spans: number[][] = [];
  for (const i of recorded) {
    const last = spans[spans.length - 1];
    if (last && i === last[last.length - 1] + 1) last.push(i);
    else spans.push([i]);
  }
  const max = rows.reduce((m, r) => Math.max(m, r.total), 0);
  return { axis: days, recorded, series, max: max > 0 ? max : 1, spans };
}

/** 单日（段只有一天）时的堆叠柱：返回每档的 y 与高度（SVG rect 直接可用）。 */
export function stackBarRects(
  series: StackSeries[],
  below: (number | null)[],
  chart: { max: number; height: number; padTop?: number; padBottom?: number },
): { key: string; y: number; h: number }[] {
  const { max, height, padTop = 0, padBottom = 0 } = chart;
  const top = series.length;
  const out: { key: string; y: number; h: number }[] = [];
  for (let i = 0; i < top; i += 1) {
    const b = below[i] ?? 0;
    const v = series[i].values[0] ?? 0;
    const yTop = valueY(b + v, max, height, padTop, padBottom);
    const yBottom = valueY(b, max, height, padTop, padBottom);
    out.push({ key: series[i].key, y: yTop, h: Math.max(0, yBottom - yTop) });
  }
  return out;
}

/** 某天下标在画布上的 x（等距；单点居中）。 */
export function pointX(index: number, count: number, width: number, padLeft = 0, padRight = 0): number {
  const inner = Math.max(1, width - padLeft - padRight);
  if (count <= 1) return padLeft + inner / 2;
  return padLeft + (index / (count - 1)) * inner;
}

/**
 * 值在画布上的 y。两条防御：`max` 为 0 视为 1（不除零）；**值夹在 [0, max]**——
 * 堆叠带按构造不会超上限，但快照若是旧版本/手工导入的脏数据就可能超，
 * 夹住至少不会把带画到画布外面去（宁可画平，不可画出界）。
 */
export function valueY(value: number, max: number, height: number, padTop = 0, padBottom = 0): number {
  const inner = Math.max(1, height - padTop - padBottom);
  const m = max > 0 ? max : 1;
  const v = Math.min(Math.max(value, 0), m);
  return padTop + inner - (v / m) * inner;
}

/**
 * 堆叠面积路径：第 i 档的**带**（从它下面所有档的累计到下沿+自身）。
 * 返回一条闭合路径（上沿左→右、下沿右→左），SVG `d` 直接可用。
 */
export function stackBandPath(
  values: (number | null)[],
  below: (number | null)[],
  span: number[],
  chart: { max: number; axisLength: number; width: number; height: number; padTop?: number; padBottom?: number; padLeft?: number; padRight?: number },
): string {
  if (span.length < 2) return ""; // 单点段交给 stackBarRects（路径零宽 = 什么都看不见）
  const { max, axisLength, width, height, padTop = 0, padBottom = 0, padLeft = 0, padRight = 0 } = chart;
  const top: string[] = [];
  const bottom: string[] = [];
  for (const i of span) {
    const x = pointX(i, axisLength, width, padLeft, padRight).toFixed(1);
    const v = values[i] ?? 0;
    const b = below[i] ?? 0;
    top.push(`${top.length === 0 ? "M" : "L"}${x},${valueY(b + v, max, height, padTop, padBottom).toFixed(1)}`);
    bottom.push(`L${x},${valueY(b, max, height, padTop, padBottom).toFixed(1)}`);
  }
  return `${top.join(" ")} ${bottom.reverse().join(" ")} Z`;
}

/** 逐日累计下沿（堆叠用）：返回与轴等长的累计数组（无记录日为 null）。 */
export function cumulativeBelow(series: StackSeries[], index: number): (number | null)[] {
  return (
    series[0]?.values.map((_, day) =>
      series[0].values[day] === null
        ? null
        : series.slice(0, index).reduce((sum, s) => sum + (s.values[day] ?? 0), 0),
    ) ?? []
  );
}

/** 分布柱状（当前状态，不依赖快照）：按某个字段的取值分组计数。 */
export interface BarDatum {
  key: string;
  label: string;
  count: number;
  color: string | null;
}

export function distributionByOption(
  values: { itemId: string; value: string | null }[],
  options: { id: string; name: string; color?: string | null }[],
): BarDatum[] {
  const order = options.map((o) => o.id);
  const byKey = new Map<string, number>();
  for (const v of values) {
    const key = v.value ?? NO_STATUS;
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  const named = options.map((o) => ({
    key: o.id,
    label: o.name,
    count: byKey.get(o.id) ?? 0,
    color: o.color ?? null,
  }));
  const rest = [...byKey.entries()]
    .filter(([k]) => !order.includes(k))
    .map(([k, count]) => ({
      key: k,
      label: k === NO_STATUS ? "" : k,
      count,
      color: null,
    }));
  return [...named, ...rest].filter((d) => d.count > 0);
}
