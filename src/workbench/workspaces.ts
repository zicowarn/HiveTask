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
  { key: "tools", labelKey: "workspace.tools", listPanel: "git.history", detailPanel: "terminal" },
];
