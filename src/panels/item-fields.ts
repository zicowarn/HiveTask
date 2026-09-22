/**
 * 项目条目的字段取值（纯函数）——Board 卡片与 Table 列共用一套渲染口径，
 * 测试不必挂 Pinia/组件。
 *
 * 两类字段来源不同：
 *  - 条目自身：title / kind / source / added（草稿卡也有）
 *  - 引用实体镜像：state / author / assignees / labels / milestone / created /
 *    updated（来自仓库缓存的 Issue/PR 元数据，草稿卡与未同步的引用为空）
 * 项目字段（status / priority）的值由 store 按字段选项解析，不在这里。
 */
import type { ProjectItem } from "../api";
import { stateLabel } from "./state-label";
import { t, type MessageKey } from "../i18n";
import type { ViewFieldId } from "./project-views";

/** ISO 时间 → 本地短日期；空值/非法值返回空串。 */
export function shortDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

/** 条目类型（草稿 / Issue / PR）。 */
export function kindLabel(item: ProjectItem): string {
  if (item.kind === "draft") return t("project.draftTag");
  return item.kind === "pull" ? t("project.kindPull") : t("project.kindIssue");
}

/** 来源标签（引用卡 = 仓库名；悬挂 / 草稿各有标记）。 */
export function sourceLabel(item: ProjectItem): string {
  if (item.ghost) return t("project.unlinked");
  if (item.kind === "draft") return t("project.draftTag");
  return item.repoLabel ?? "";
}

/** 卡片/行的主标题：草稿题 → 引用实体标题 → #编号。 */
export function itemTitle(item: ProjectItem): string {
  if (item.draftTitle) return item.draftTitle;
  if (item.entity?.title) return item.entity.title;
  return item.number ? `#${item.number}` : "";
}

/** 引用实体镜像字段的显示文本；无实体或无值 → null（调用方隐藏该格）。 */
export function entityFieldText(id: ViewFieldId, item: ProjectItem): string | null {
  const entity = item.entity;
  if (!entity) return null;
  switch (id) {
    case "state":
      return stateLabel(entity.state) || null;
    case "author":
      return entity.author ? `@${entity.author}` : null;
    case "assignees":
      return entity.assignees.length ? entity.assignees.map((a) => `@${a}`).join(", ") : null;
    case "labels":
      return entity.labels.length ? entity.labels.join(", ") : null;
    case "milestone":
      return entity.milestone ?? null;
    case "created":
      return shortDate(entity.createdAt) || null;
    case "updated":
      return shortDate(entity.updatedAt) || null;
    default:
      return null;
  }
}

/** 字段名（字段面板与表头共用；i18n key 一处定义）。 */
export const fieldLabelKeys: Record<ViewFieldId, MessageKey> = {
  title: "project.colTitle",
  kind: "project.colKind",
  source: "project.colSource",
  added: "project.colAdded",
  state: "project.colState",
  author: "project.colAuthor",
  assignees: "project.colAssignees",
  labels: "project.colLabels",
  milestone: "project.colMilestone",
  created: "project.colCreated",
  updated: "project.colUpdated",
  status: "project.colStatus",
  priority: "project.colPriority",
};
