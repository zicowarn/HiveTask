/**
 * Workspace definitions — plain data kept separate from registry.ts so the
 * workbench layout store can read workspace panel types without importing
 * the component graph (which would create a module cycle through PanelShell).
 */
export interface WorkspaceDefinition {
  key: string;
  label: string;
  listPanel: string;
  detailPanel: string;
}

export const workspaces: WorkspaceDefinition[] = [
  { key: "issues", label: "Issues", listPanel: "issue.list", detailPanel: "issue.detail" },
  { key: "pulls", label: "Pull Requests", listPanel: "pull.list", detailPanel: "pull.detail" },
];
