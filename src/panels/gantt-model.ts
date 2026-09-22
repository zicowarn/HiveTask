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
  /** 条目形态（依赖编辑的写路由按它分级：draft/本地 issue 可写，平台引用 G3-b）。 */
  kind: "issue" | "pull" | "draft";
  title: string;
  /** 计划起止（YYYY-MM-DD 或 ISO；调用方保证合法或 null）。 */
  start: string | null;
  end: string | null;
  /** 条目已闭合（issue CLOSED）：进度按 100 记——状态是完成的权威语义，
   *  子 Issue 摘要只是过程度量。 */
  closed?: boolean;
  /** 进度字段（Number）显式值：配置后优先于派生（抽屉里改进度写它）。 */
  progressOverride?: number | null;
  relations: IssueRelations | null;
  /** 容器真源依赖（app.db project_item_deps，origin=NULL）：被依赖条目 id。 */
  localDeps?: string[];
  /** 容器真源上级（app.db project_item_parents，origin=NULL）：优先级高于平台
   *  镜像——上层是我们排的计划（§3 结构扩展泳道）。 */
  localParent?: string | null;
  /** 资源 = 负责人（平台 assignees 镜像 / journal 负责人；草稿未分配为空）。 */
  assignees?: string[];
  /** 实际起止与工时（项目字段，甘特计划面 §5）。 */
  actualStart?: string | null;
  actualEnd?: string | null;
  estimatedHours?: number | null;
  actualHours?: number | null;
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
  /** 被本任务依赖的任务 id（平台镜像 ∪ 容器真源，命中板内条目）。 */
  dependsOn: string[];
  /** 上级条目 id（本地真源优先，其次平台镜像）；null = 顶层。 */
  parentId: string | null;
  /** 资源 = 负责人（甘特计划面 §5）。 */
  assignees: string[];
  actualStart: string | null;
  actualEnd: string | null;
  estimatedHours: number | null;
  actualHours: number | null;
  /** 依赖违规：后继开始早于某前驱结束（甘特计划面 §6 调度语义第一步）。
   *  值 = 违规的前驱条目 id 列表。 */
  violations: string[];
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
  const taskById0 = new Map(tasks.map((t) => [t.id, t]));
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
  // 上级优先级：容器真源（我们排的计划）> 平台镜像（sub-issues）
  for (const t of tasks) {
    if (t.localParent) {
      const up = taskById0.get(t.localParent);
      if (up) link(t.id, up.id);
    }
  }
  for (const t of tasks) {
    if (parentOf.has(t.id)) continue; // 本地已定上级，平台镜像不覆盖
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
    for (const dep of t.localDeps ?? []) {
      if (!out.includes(dep)) out.push(dep); // 平台镜像 ∪ 容器真源，去重
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
    // 优先级：显式进度字段 > 闭合(100) > 子 Issue 摘要 > 无
    const progress =
      t.progressOverride ?? (t.closed ? 100 : summary && summary.total > 0
        ? Math.round((summary.completed / summary.total) * 100)
        : null);
    const self = {
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
      parentId: parentOf.get(t.id) ?? null,
      assignees: t.assignees ?? [],
      actualStart: t.actualStart ? day(t.actualStart) : null,
      actualEnd: t.actualEnd ? day(t.actualEnd) : null,
      estimatedHours: t.estimatedHours ?? null,
      actualHours: t.actualHours ?? null,
      violations: [] as string[],
      children: kids,
    };
    // 依赖违规（调度语义第一步）：后继开始早于前驱结束（FS：前驱未完不得开工）。
    // node 的 start/end 已规范化为 YYYY-MM-DD，直接字符串比较。
    for (const depId of self.dependsOn) {
      const dep = taskById.get(depId);
      if (!dep) continue;
      const depEnd = dep.end ? day(dep.end) : null; // 规范化（原始值可能带时间）
      const myStart = self.start;
      if (depEnd && myStart && myStart < depEnd) self.violations.push(depId);
    }
    return self;
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
 * 环检测（新建依赖前的 UX 预检；Rust 侧 dep_add_in 为权威，两者同构）：
 * 从 dependsOn 沿「依赖谁」方向走，回到 itemId 即成环。
 */
export function wouldCreateCycle(
  deps: Record<string, string[]>,
  itemId: string,
  dependsOn: string,
): boolean {
  if (itemId === dependsOn) return true;
  const stack = [dependsOn];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === itemId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(deps[cur] ?? []));
  }
  return false;
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

/**
 * 工具条折叠判定（纯函数，便于测试）：内在宽度 > 可用宽 → 折叠；
 * 折叠后需回到「所需宽 + 迟滞」之上才展回（避免边界抖动）。
 * 返回 null = 维持现状。
 */
export function foldToolbarDecision(
  collapsed: boolean,
  intrinsicWidth: number,
  availableWidth: number,
  slack = 24,
): boolean | null {
  if (!collapsed) return intrinsicWidth > availableWidth ? true : null;
  return availableWidth >= intrinsicWidth + slack ? false : null;
}

/** 任务编辑面板的保存负载（表单收集 → 父面板按写路由落库）。 */
export interface TaskFormPayload {
  title: string;
  body?: string;
  assignees: string[];
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  estHours: number | null;
  actualHours: number | null;
  progress: number | null;
  predecessorIds: string[];
  /** 上级条目 id（null = 置空/顶层）——本地结构泳道。 */
  parentId: string | null;
  /** 资源分配（§5-bis）：资源 id + 占用比例（20–100）。 */
  resources: { resourceId: string; allocation: number }[];
}
