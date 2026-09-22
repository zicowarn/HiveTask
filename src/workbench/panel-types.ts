/**
 * Panel type metadata — plain data kept out of registry.ts so consumers
 * (PanelShell's Editor switcher, the workbench store whitelist) can read
 * panel types without importing the component graph. Importing registry from
 * PanelShell would close a cycle (registry → panel component → PanelShell →
 * registry), the class of cycle that previously caused a TDZ white screen;
 * this leaf module breaks it.
 *
 * Titles/categories are i18n *keys*, not text: a plain module resolves nothing
 * at import time, so storing translated strings here would freeze the language
 * that happened to be active at load. Components resolve keys with `t()`.
 */
import type { MessageKey } from "../i18n";

export interface PanelTypeInfo {
  type: string;
  titleKey: MessageKey;
  /** 切换弹层里的分类标题（i18n key）——排序归类的唯一事实源。 */
  category: MessageKey;
  /** EditorIcon 的图形名（14px 内联 SVG，currentColor）。 */
  icon:
    | "issue.list"
    | "issue.detail"
    | "pull"
    | "pull.detail"
    | "project.board"
    | "project.gantt"
    | "git.history"
    | "terminal"
    | "o.calendar"
    | "o.graph"
    | "o.people"
    | "settings"
    | "o.book";
}

/** 分类展示顺序：对齐工作区叙事（Issues → Pull Requests → 项目 → 知识库 → 工具 → 通用）。 */
export const editorCategories: MessageKey[] = [
  "editorCat.issues",
  "editorCat.pulls",
  "editorCat.projects",
  "editorCat.knowledge",
  "editorCat.tools",
  "editorCat.general",
];

export const panelTypes: PanelTypeInfo[] = [
  { type: "issue.list", titleKey: "panelTitle.issue.list", category: "editorCat.issues", icon: "issue.list" },
  { type: "issue.detail", titleKey: "panelTitle.issue.detail", category: "editorCat.issues", icon: "issue.detail" },
  { type: "pull.list", titleKey: "panelTitle.pull.list", category: "editorCat.pulls", icon: "pull" },
  { type: "pull.detail", titleKey: "panelTitle.pull.detail", category: "editorCat.pulls", icon: "pull.detail" },
  { type: "project.board", titleKey: "panelTitle.project.board", category: "editorCat.projects", icon: "project.board" },
  { type: "project.gantt", titleKey: "panelTitle.project.gantt", category: "editorCat.projects", icon: "project.gantt" },
  { type: "project.resources", titleKey: "panelTitle.project.resources", category: "editorCat.projects", icon: "o.people" },
  { type: "knowledge.workbench", titleKey: "panelTitle.knowledge.workbench", category: "editorCat.knowledge", icon: "o.book" },
  { type: "knowledge.graph", titleKey: "panelTitle.knowledge.graph", category: "editorCat.knowledge", icon: "o.graph" },
  { type: "git.history", titleKey: "panelTitle.git.history", category: "editorCat.tools", icon: "git.history" },
  { type: "terminal", titleKey: "panelTitle.terminal", category: "editorCat.tools", icon: "terminal" },
  { type: "calendar", titleKey: "panelTitle.calendar", category: "editorCat.tools", icon: "o.calendar" },
  { type: "settings", titleKey: "panelTitle.settings", category: "editorCat.general", icon: "settings" },
];
