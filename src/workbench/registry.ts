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
import ProjectPanel from "../panels/ProjectPanel.vue";
import SettingsPanel from "../panels/SettingsPanel.vue";
import GitHistoryPanel from "../panels/GitHistoryPanel.vue";
import TerminalPanel from "../panels/TerminalPanel.vue";
import IssueListMode from "../panels/modes/IssueListMode.vue";
import IssueMilestoneMode from "../panels/modes/IssueMilestoneMode.vue";
import ProjectBoardMode from "../panels/modes/ProjectBoardMode.vue";
import ProjectTableMode from "../panels/modes/ProjectTableMode.vue";
import SettingsBasicMode from "../panels/modes/SettingsBasicMode.vue";
import { workspaces } from "./workspaces";
import type { MessageKey } from "../i18n";

export type { WorkspaceDefinition } from "./workspaces";
export { workspaces };

export interface ModeDefinition {
  key: string;
  /** i18n key; ModeTabs resolves it so a locale switch re-renders. */
  labelKey: MessageKey;
  component: Component;
}

export interface PanelDefinition {
  type: string;
  component: Component;
  modes?: ModeDefinition[];
}

const panels = new Map<string, PanelDefinition>();

function registerPanel(type: string, component: Component, modes?: ModeDefinition[]): void {
  panels.set(type, { type, component, modes });
}

export function resolvePanel(type: string): PanelDefinition {
  const panel = panels.get(type);
  if (!panel) throw new Error(`Unregistered panel type: ${type}`);
  return panel;
}

registerPanel("issue.list", IssueListPanel, [
  { key: "list", labelKey: "mode.list", component: IssueListMode },
  { key: "milestone", labelKey: "mode.milestone", component: IssueMilestoneMode },
]);
registerPanel("issue.detail", IssueDetailPanel);
registerPanel("pull.list", PullListPanel);
registerPanel("pull.detail", PullDetailPanel);
registerPanel("project.board", ProjectPanel, [
  { key: "board", labelKey: "mode.board", component: ProjectBoardMode },
  { key: "table", labelKey: "mode.table", component: ProjectTableMode },
]);
registerPanel("git.history", GitHistoryPanel);
registerPanel("terminal", TerminalPanel);
registerPanel("settings", SettingsPanel, [
  { key: "basic", labelKey: "mode.settings.basic", component: SettingsBasicMode },
]);
