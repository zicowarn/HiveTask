/**
 * Panel type metadata — plain data kept out of registry.ts so consumers
 * (PanelShell's Editor switcher, the workbench store whitelist) can read
 * panel types/titles without importing the component graph. Importing
 * registry from PanelShell would close a cycle
 * (registry → panel component → PanelShell → registry), the class of cycle
 * that previously caused a TDZ white screen; this leaf module breaks it.
 */
export interface PanelTypeInfo {
  type: string;
  title: string;
}

export const panelTypes: PanelTypeInfo[] = [
  { type: "issue.list", title: "Issue 列表" },
  { type: "issue.detail", title: "Issue 详情" },
  { type: "pull.list", title: "PR 列表" },
  { type: "pull.detail", title: "PR 详情" },
];

export function panelTitle(type: string): string {
  return panelTypes.find((p) => p.type === type)?.title ?? type;
}
