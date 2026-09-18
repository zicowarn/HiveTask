/**
 * 日历事件聚合（纯函数，无 UI、无 store 依赖）——把**已缓存**的日期数据
 * 归一成日历面板要的形状。日历是投影图层（设计定案：不存任何数据、
 * 不做第二个日期真源），本模块只做「真源 → 事件」的转换：
 *  - 里程碑 due_on（issues store 每仓库缓存，远端为权威）
 *  - Issue / PR createdAt（仓库缓存 SQLite）
 *  - 项目日期字段值（app.db，经 projects store 已加载的 fields/items）
 */

import type { MilestoneInfo, ProjectField, ProjectItem } from "../api";
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

/** 提交热力强度档（GitHub 贡献图口径）：0 无 / 1 低 / 2 中 / 3 高 / 4 峰值。 */
export function heatBucket(count: number): number {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
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
