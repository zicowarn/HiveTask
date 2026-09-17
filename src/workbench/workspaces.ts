/**
 * Workspace definitions — plain data kept separate from registry.ts so the
 * workbench layout store can read workspace panel types without importing
 * the component graph (which would create a module cycle through PanelShell).
 *
 * Labels are i18n keys resolved by App.vue's tab bar. (Issues/Pull Requests
 * were plain strings while both locales happened to spell them the same;
 * the Tools workspace broke that coincidence.)
 */
import type { MessageKey } from "../i18n";

export interface WorkspaceDefinition {
  key: string;
  labelKey: MessageKey;
  listPanel: string;
  detailPanel: string;
}

export const workspaces: WorkspaceDefinition[] = [
  { key: "issues", labelKey: "workspace.issues", listPanel: "issue.list", detailPanel: "issue.detail" },
  { key: "pulls", labelKey: "workspace.pulls", listPanel: "pull.list", detailPanel: "pull.detail" },
  { key: "projects", labelKey: "workspace.projects", listPanel: "project.board", detailPanel: "project.board" },
  // 知识库：单面板（listPanel === detailPanel，同「项目」），树与编辑器/预览在面板内部自行分栏——
  // 双面板模型下类型切换器会把文件树整块换掉、能拆开、能单关一半，都不该发生。
  { key: "knowledge", labelKey: "workspace.knowledge", listPanel: "knowledge.workbench", detailPanel: "knowledge.workbench" },
  { key: "tools", labelKey: "workspace.tools", listPanel: "git.history", detailPanel: "terminal" },
];
