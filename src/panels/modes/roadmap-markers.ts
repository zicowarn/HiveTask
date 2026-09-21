/**
 * Roadmap 里程碑标记线（对齐平台 Markers → milestones）：纯投影——
 * 条目引用的里程碑（EntityMeta.milestone 标题）× 各仓库里程碑列表的
 * due_on → 时间轴垂直标记线。不产生数据、不回写；无截止日或仓库未同步
 * 的里程碑诚实缺席，不造假日期。
 */
import type { ProjectItem } from "../../api";

/** 一条标记线：里程碑名 + 截止日（时间轴 x 位置由日期决定）。 */
export interface RoadmapMarker {
  /** repoId::里程碑标题（同仓库多条目共用一个里程碑只画一条线）。 */
  key: string;
  title: string;
  /** YYYY-MM-DD（due_on RFC3339 的日期部分）。 */
  date: string;
}

/** 每仓库的里程碑元数据（label = 仓库显示名，跨仓撞名时消歧用）。 */
export interface MilestoneMetaSource {
  label: string;
  list: { title: string; dueOn: string | null }[];
}

export function collectMarkers(
  items: Pick<ProjectItem, "repoId" | "entity">[],
  metaByRepo: Record<string, MilestoneMetaSource>,
): RoadmapMarker[] {
  // 条目 → (repoId, 里程碑标题) 去重
  const seen = new Set<string>();
  const pairs: { repoId: string; title: string }[] = [];
  for (const it of items) {
    const title = it.entity?.milestone;
    if (!title || !it.repoId) continue;
    const key = `${it.repoId}::${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ repoId: it.repoId, title });
  }
  // 标题 → due_on（按标题匹配；无截止日 / 仓库元数据缺席 → 不出线）
  const dated = pairs
    .map((p) => {
      const dueOn = metaByRepo[p.repoId]?.list.find((m) => m.title === p.title)?.dueOn;
      return dueOn ? { ...p, date: dueOn.slice(0, 10) } : null;
    })
    .filter((m): m is { repoId: string; title: string; date: string } => !!m);
  // 跨仓同名里程碑：两条线都保留，标题补仓库显示名消歧
  const dup = new Map<string, number>();
  for (const m of dated) dup.set(m.title, (dup.get(m.title) ?? 0) + 1);
  return dated
    .map((m) => ({
      key: `${m.repoId}::${m.title}`,
      title:
        (dup.get(m.title) ?? 0) > 1 ? `${m.title}（${metaByRepo[m.repoId]?.label ?? ""}）` : m.title,
      date: m.date,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 条目日期标记（平台 Markers → Start date / Due date）：某日期字段的
 *  全部取值 → 去重日期列表（每个不同日期一个深色小三角，升序）。
 *  与里程碑线同族：纯投影，非法/缺失值诚实跳过。 */
export function collectDateMarkers(
  items: Pick<ProjectItem, "fieldValues">[],
  fieldId: string | null | undefined,
): string[] {
  if (!fieldId) return [];
  const dates = new Set<string>();
  for (const it of items) {
    const raw = it.fieldValues[fieldId];
    if (!raw) continue;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;
    dates.add(d.toISOString().slice(0, 10));
  }
  return [...dates].sort();
}
