/**
 * Workbench panel registry: a `panelType -> component` map. Workspaces
 * resolve their panes through `resolvePanel()` and render them with
 * <component :is>. Add a panel by importing it here and registering one
 * entry — no global singleton state required.
 */
import type { Component } from "vue";
import IssueListPanel from "../panels/IssueListPanel.vue";
import IssueDetailPanel from "../panels/IssueDetailPanel.vue";
import PullListPanel from "../panels/PullListPanel.vue";
import PullDetailPanel from "../panels/PullDetailPanel.vue";

export interface PanelDefinition {
  type: string;
  component: Component;
}

const panels = new Map<string, PanelDefinition>();

function registerPanel(type: string, component: Component): void {
  panels.set(type, { type, component });
}

export function resolvePanel(type: string): PanelDefinition {
  const panel = panels.get(type);
  if (!panel) throw new Error(`未注册的面板类型: ${type}`);
  return panel;
}

export interface WorkspaceDefinition {
  key: string;
  label: string;
  listPanel: string;
  detailPanel: string;
}

registerPanel("issue.list", IssueListPanel);
registerPanel("issue.detail", IssueDetailPanel);
registerPanel("pull.list", PullListPanel);
registerPanel("pull.detail", PullDetailPanel);

export const workspaces: WorkspaceDefinition[] = [
  { key: "issues", label: "Issues", listPanel: "issue.list", detailPanel: "issue.detail" },
  { key: "pulls", label: "Pull Requests", listPanel: "pull.list", detailPanel: "pull.detail" },
];
