/**
 * 日历事件聚合（纯函数，无 UI、无 store 依赖）——把**已缓存**的日期数据
 * 归一成日历面板要的形状。日历是投影图层（设计定案：不存任何数据、
 * 不做第二个日期真源），本模块只做「真源 → 事件」的转换：
 *  - 里程碑 due_on（issues store 每仓库缓存，远端为权威）
 *  - Issue / PR createdAt（仓库缓存 SQLite）
 *  - 项目日期字段值（app.db，经 projects store 已加载的 fields/items）
 */

import type { CalendarEventRow, MilestoneInfo, ProjectField, ProjectItem } from "../api";
import type { Issue, Pull } from "../types";

export type CalendarEventKind = "milestone" | "issue" | "pull" | "project";

export interface CalendarEvent {
  /** 本地日期 YYYY-MM-DD。 */
  date: string;
  kind: CalendarEventKind;
  /** 稳定 key（同日同名事件也必须唯一）。 */
  id: string;
  title: string;
  /** 「在 GitHub 打开」用；本地 Issue / 项目日期无 url → null。 */
  url: string | null;
}

/** ISO 时间串 → 本地日期 YYYY-MM-DD；空串/非法值 → null（诚实跳过）。 */
export function localDateOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Date → 本地日期键 YYYY-MM-DD（热力角标用；不经 UTC 往返，避免日界漂移）。 */
export function dateKey(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 解析 YYYY-MM-DD 为本地 Date；非法返回 null（避免 UTC 解析漂移）。 */
function parseLocal(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 本地日期 +n 天。 */
export function addDaysLocal(s: string, n: number): string {
  const d = parseLocal(s);
  if (!d) return s;
  return dateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

/**
 * 重复日程是否在指定日期发生（按起始日锚定：weekly 同星期、monthly 同日、
 * yearly 同月日；短月/平年自然跳过）。跨度（end-start）随发生日平移；
 * 不重复 = 仅原跨度命中。
 */
export function occursOn(
  startDate: string,
  endDate: string | null,
  recur: string,
  date: string,
): boolean {
  const s = parseLocal(startDate);
  const t = parseLocal(date);
  if (!s || !t || t < s) return false;
  const delta = endDate ? Math.round((parseLocal(endDate)!.getTime() - s.getTime()) / 86400e3) : 0;
  const hit = (occ: Date): boolean =>
    t.getTime() >= occ.getTime() && t.getTime() <= occ.getTime() + delta * 86400e3;
  /** 发生日 = t 往回最多 delta 天内满足锚定谓词且 ≥ 起始日的日期。 */
  const hitBy = (pred: (o: Date) => boolean): boolean => {
    for (let k = 0; k <= delta; k++) {
      const occ = new Date(t.getFullYear(), t.getMonth(), t.getDate() - k);
      if (occ < s) break;
      if (pred(occ)) return true;
    }
    return false;
  };
  switch (recur) {
    case "daily":
      return true;
    case "weekly": {
      // weekly:N（ISO：1=周一…7=周日）；无后缀锚定起始日星期
      const m = /^weekly:(\d)$/.exec(recur);
      if (m) {
        const iso = Number(m[1]) % 7; // ISO 7(周日) → getDay 0
        return hitBy((o) => o.getDay() === iso);
      }
      return hitBy((o) => o.getDay() === s.getDay());
    }
    case "monthly":
      return hitBy((o) => o.getDate() === s.getDate());
    case "yearly":
      return hitBy((o) => o.getMonth() === s.getMonth() && o.getDate() === s.getDate());
    case "lunar":
      return false; // 农历锚定需农历数据，调用方经 matcher 处理
    default:
      return hit(s);
  }
}

/**
 * 展开可视区间 [from, to] 内的发生起始日（升序）。不重复规则若跨度与区间
 * 相交，返回 [startDate]（渲染端用 fc end 补跨度）。
 */
export function expandOccurrences(
  startDate: string,
  endDate: string | null,
  recur: string,
  from: string,
  to: string,
): string[] {
  if (recur === "") {
    const overlaps = (endDate ?? startDate) >= from && startDate <= to;
    return overlaps ? [startDate] : [];
  }
  const out: string[] = [];
  let cursor = startDate > from ? startDate : from;
  const toD = parseLocal(to);
  const toIncl = toD ? dateKey(new Date(toD.getFullYear(), toD.getMonth(), toD.getDate() + 1)) : to;
  let guard = 0;
  while (cursor <= toIncl && guard < 400) {
    guard++;
    if (occursOn(startDate, endDate, recur, cursor)) out.push(cursor);
    cursor = addDaysLocal(cursor, 1);
  }
  return out;
}

/**
 * 覆盖指定日期的日程（含跨日与重复展开判定）。
 * 状态栏「今日日程」与日历面板共用的口径——只数手建日程（"今天要做什么"），
 * 订阅/节气/农历/热力等"今天是什么日子"不计入。
 */
export function eventsOnDate(rows: CalendarEventRow[], date: string): CalendarEventRow[] {
  return rows.filter((e) => occursOn(e.startDate, e.endDate, e.recur, date));
}

/** 提交热力强度档（GitHub 贡献图口径）：0 无 / 1 低 / 2 中 / 3 高 / 4 峰值。 */
export function heatBucket(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

/**
 * 图层折叠优先级（用户定案「日程、节气和假日优先位于顶部」）：格高不足触发
 * fc dayMaxEvents 折叠时，按此值升序保留（小者先显示），投影类（里程碑/议题/
 * PR/项目日期）让位进「+N 更多」。同层回退 fc 默认排序（start/-duration/allDay/title）。
 * 判定按事件 id 前缀：`event:` 手建日程、`feed:` ICS 订阅，其余皆投影。
 */
export function layerPrio(eventId: string): number {
  if (eventId.startsWith("event:")) return 0;
  if (eventId.startsWith("feed:")) return 1;
  return 2;
}

export interface CalendarEventInput {
  milestones: MilestoneInfo[];
  issues: Issue[];
  pulls: Pull[];
  projectFields: ProjectField[];
  projectItems: ProjectItem[];
}

export function buildCalendarEvents(input: CalendarEventInput): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const m of input.milestones) {
    const date = localDateOf(m.dueOn);
    if (!date) continue;
    events.push({ date, kind: "milestone", id: `milestone:${m.number}`, title: m.title, url: m.htmlUrl });
  }

  for (const issue of input.issues) {
    const date = localDateOf(issue.createdAt);
    if (!date) continue;
    events.push({
      date,
      kind: "issue",
      id: `issue:${issue.number}`,
      title: `#${issue.number} ${issue.title}`,
      url: issue.url ?? null,
    });
  }

  for (const pull of input.pulls) {
    const date = localDateOf(pull.createdAt);
    if (!date) continue;
    events.push({
      date,
      kind: "pull",
      id: `pull:${pull.number}`,
      title: `#${pull.number} ${pull.title}`,
      url: pull.url ?? null,
    });
  }

  // 项目日期字段：每个「日期类型字段且有值」的条目落一个事件（字段名进标题，
  // 一个条目多个日期字段各自成事件，与 Roadmap 的单字段投影不冲突）。
  const dateFields = input.projectFields.filter((f) => f.kind === "date");
  if (dateFields.length > 0) {
    for (const item of input.projectItems) {
      for (const field of dateFields) {
        const date = localDateOf(item.fieldValues[field.id]);
        if (!date) continue;
        const title = itemTitle(item);
        events.push({
          date,
          kind: "project",
          id: `project:${item.id}:${field.id}`,
          title: field.name ? `${title} · ${field.name}` : title,
          url: null,
        });
      }
    }
  }

  return events;
}

/** 条目标题：草稿用 draftTitle；引用实体用镜像元数据；悬挂引用兜底编号。 */
function itemTitle(item: ProjectItem): string {
  if (item.kind === "draft") return item.draftTitle ?? "—";
  if (item.entity?.title) {
    return item.number ? `#${item.number} ${item.entity.title}` : item.entity.title;
  }
  return item.number ? `#${item.number}` : "—";
}
