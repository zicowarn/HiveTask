/**
 * Workbench panel registry: a `panelType -> component` map. Workspaces
 * resolve their panes through `resolvePanel()` and render them with
 * <component :is>. Add a panel by importing it here and registering one
 * entry — no global singleton state required.
 *
 * A panel may declare several modes — switchable views inside the same
 * panel chrome (e.g. the issue list's flat list vs. milestone grouping).
 * Panels without `modes` have a single view and show no mode switcher.
 */
import type { Component } from "vue";
import IssueListPanel from "../panels/IssueListPanel.vue";
import IssueDetailPanel from "../panels/IssueDetailPanel.vue";
import PullListPanel from "../panels/PullListPanel.vue";
import PullDetailPanel from "../panels/PullDetailPanel.vue";
import IssueListMode from "../panels/modes/IssueListMode.vue";
import IssueMilestoneMode from "../panels/modes/IssueMilestoneMode.vue";
import { workspaces } from "./workspaces";
import { panelTitle } from "./panel-types";

export type { WorkspaceDefinition } from "./workspaces";
export { workspaces };

export interface ModeDefinition {
  key: string;
  label: string;
  component: Component;
}

export interface PanelDefinition {
  type: string;
  /** Human label sourced from the plain-data panel-types catalog. */
  title: string;
  component: Component;
  modes?: ModeDefinition[];
}

const panels = new Map<string, PanelDefinition>();

function registerPanel(type: string, component: Component, modes?: ModeDefinition[]): void {
  panels.set(type, { type, title: panelTitle(type), component, modes });
}

export function resolvePanel(type: string): PanelDefinition {
  const panel = panels.get(type);
  if (!panel) throw new Error(`未注册的面板类型: ${type}`);
  return panel;
}

registerPanel("issue.list", IssueListPanel, [
  { key: "list", label: "列表", component: IssueListMode },
  { key: "milestone", label: "里程碑", component: IssueMilestoneMode },
]);
registerPanel("issue.detail", IssueDetailPanel);
registerPanel("pull.list", PullListPanel);
registerPanel("pull.detail", PullDetailPanel);
