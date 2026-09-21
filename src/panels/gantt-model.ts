/**
 * 甘特投影（纯函数，无 UI/store 依赖）：
 * 项目条目 + Issue 关系（G1 数据层）→ WBS 任务树 + 依赖箭头几何。
 *
 * 真源口径（《架构设计-项目甘特图》§4）：起止 = 项目日期字段（调用方解析好
 * 传入）、依赖/父子/进度 = 平台关系数据（GitHub 全量 / Gitea 仅依赖 /
 * Gitee·本地无——无则诚实缺席，不造假）。
 */
import type { IssueRelations } from "../api";

/** 投影输入：调用方已把日期字段与标题解析好。 */
export interface GanttTask {
  id: string;
  repoId: string | null;
  number: string | null;
  title: string;
  /** 计划起止（YYYY-MM-DD 或 ISO；调用方保证合法或 null）。 */
  start: string | null;
  end: string | null;
  /** 条目已闭合（issue CLOSED）：进度按 100 记——状态是完成的权威语义，
   *  子 Issue 摘要只是过程度量。 */
  closed?: boolean;
  relations: IssueRelations | null;
}

export interface GanttNode {
  id: string;
  /** WBS 缩进层级（0 = 顶层）。 */
  depth: number;
  repoId: string | null;
  number: string | null;
  title: string;
  /** 起止（父行无自身日期时 = 子行聚合：min start / max end）。 */
  start: string | null;
  end: string | null;
  /** 进度 0–100（子 Issue 摘要；无数据 null = 不画进度）。 */
  progress: number | null;
  childCount: number;
  /** 被本任务依赖的任务 id（平台 blockedBy 命中板内条目）。 */
  dependsOn: string[];
}

/** 建树中间态（children 只在 buildGanttTree 内部用，扁平行不带）。 */
type GanttTree = GanttNode & { children: GanttTree[] };

const day = (iso: string) => iso.slice(0, 10);

/**
 * 任务数组 → WBS 扁平行（深度优先：父行后紧跟子树；孤儿保持输入顺序置顶）。
 *
 * 父子边取双向并集：A.parent == B 或 B.subIssues 含 A（同仓库同编号才算）。
 * 防御环：已挂到某父下的节点不再作为其他父的子（首见优先）。
 */
export function buildGanttTree(tasks: GanttTask[]): GanttNode[] {
  const byKey = new Map<string, GanttTask>();
  for (const t of tasks) {
    if (t.repoId && t.number) byKey.set(`${t.repoId}::${t.number}`, t);
  }
  const parentOf = new Map<string, string>(); // childId → parentId
  const childrenOf = new Map<string, string[]>();
  const link = (childId: string, parentId: string) => {
    if (childId === parentId) return;
    if (parentOf.has(childId)) return; // 首见优先，防环
    parentOf.set(childId, parentId);
    const arr = childrenOf.get(parentId) ?? [];
    arr.push(childId);
    childrenOf.set(parentId, arr);
  };
  for (const t of tasks) {
    if (!t.repoId || !t.number) continue;
    const parent = t.relations?.parent;
    if (parent) {
      const up = byKey.get(`${t.repoId}::${parent.number}`);
      if (up) link(t.id, up.id);
    }
    for (const sub of t.relations?.subIssues ?? []) {
      const down = byKey.get(`${t.repoId}::${sub.number}`);
      if (down) link(down.id, t.id);
    }
  }

  const depsOf = (t: GanttTask): string[] => {
    const out: string[] = [];
    for (const ref of t.relations?.blockedBy ?? []) {
      const target = t.repoId ? byKey.get(`${t.repoId}::${ref.number}`) : undefined;
      if (target) out.push(target.id);
    }
    return out;
  };

  const emitted = new Set<string>();
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  // 建树（子先算出，父才能聚合）→ 压平（父在子前）
  const snap = (t: GanttTask, depth: number): GanttTree => {
    emitted.add(t.id);
    const kids = (childrenOf.get(t.id) ?? [])
      .filter((id) => !emitted.has(id))
      .map((id) => snap(taskById.get(id)!, depth + 1));
    const childStarts = kids.map((k) => k.start).filter((d): d is string => !!d);
    const childEnds = kids.map((k) => k.end).filter((d): d is string => !!d);
    const start =
      t.start ?? (childStarts.length ? childStarts.reduce((a, b) => (a < b ? a : b)) : null);
    const end = t.end ?? (childEnds.length ? childEnds.reduce((a, b) => (a > b ? a : b)) : null);
    const summary = t.relations?.subSummary;
    const progress = t.closed
      ? 100
      : summary && summary.total > 0
        ? Math.round((summary.completed / summary.total) * 100)
        : null;
    return {
      id: t.id,
      depth,
      repoId: t.repoId,
      number: t.number,
      title: t.title,
      start: start ? day(start) : null,
      end: end ? day(end) : null,
      progress,
      childCount: kids.length,
      dependsOn: depsOf(t),
      children: kids,
    };
  };

  const roots: GanttTree[] = [];
  for (const t of tasks) {
    if (!parentOf.has(t.id) && !emitted.has(t.id)) roots.push(snap(t, 0));
  }
  for (const t of tasks) {
    if (!emitted.has(t.id)) roots.push(snap(t, 0));
  }

  const flat: GanttNode[] = [];
  const walk = (n: GanttTree) => {
    const { children, ...rest } = n;
    flat.push(rest);
    for (const c of children) walk(c);
  };
  for (const r of roots) walk(r);
  return flat;
}

/**
 * 结束字段的默认推断（甘特语义 = 工期，结束字段不该默认「无」——
 * Roadmap 的「默认无」惯例不适用于甘特，用户 2026-09-21 定正）：
 * 开始字段之外，优先名字带 结束/End/Due/截止 的字段，否则剩余第一个；
 * 只有一个日期字段（与开始相同）→ null（诚实单日条）。
 */
export function defaultEndField(
  fields: { id: string; name: string }[],
  startId: string | null | undefined,
): string | null {
  const rest = fields.filter((f) => f.id !== startId);
  if (!rest.length) return null;
  return rest.find((f) => /结束|end|due|截止/i.test(f.name))?.id ?? rest[0]!.id;
}

/** 甘特时间窗：覆盖全部有日期行；无日期则围绕今天前后各 30 天。 */
export function ganttRange(nodes: GanttNode[], today: Date): { from: Date; to: Date } {
  const times = nodes
    .flatMap((n) => [n.start, n.end])
    .filter((d): d is string => !!d)
    .map((d) => new Date(d + "T00:00:00").getTime());
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const to = new Date(from);
  if (times.length) {
    from.setTime(Math.min(...times) - 3 * 86_400_000);
    to.setTime(Math.max(...times) + 7 * 86_400_000);
  } else {
    from.setTime(from.getTime() - 30 * 86_400_000);
    to.setTime(to.getTime() + 30 * 86_400_000);
  }
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);
  return { from, to };
}

/**
 * 依赖箭头折线（SVG path d）：经典甘特走线——源条右缘出发、前方留隙、
 * 竖直换行、箭头指向目标条左缘；目标在源左侧时走"回折"（绕行下方 8px）。
 * 返回 d 与箭头终点（画 marker 用）。
 */
export function arrowPath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  gap = 8,
): { d: string; tipX: number; tipY: number } {
  const tipX = toX;
  const tipY = toY;
  if (toX >= fromX + gap * 2) {
    const midX = fromX + gap;
    const d = `M ${fromX} ${fromY} H ${midX} V ${toY} H ${tipX - 1}`;
    return { d, tipX, tipY };
  }
  // 回折：右出 → 竖直 → 左折到目标左侧留隙 → 下探到目标行 → 右进
  const laneY = toY + 14;
  const d = `M ${fromX} ${fromY} H ${fromX + gap} V ${laneY} H ${tipX - gap} V ${tipY} H ${tipX - 1}`;
  return { d, tipX, tipY };
}
