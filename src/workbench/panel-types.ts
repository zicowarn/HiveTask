/**
 * Panel type metadata — plain data kept out of registry.ts so consumers
 * (PanelShell's Editor switcher, the workbench store whitelist) can read
 * panel types without importing the component graph. Importing registry from
 * PanelShell would close a cycle (registry → panel component → PanelShell →
 * registry), the class of cycle that previously caused a TDZ white screen;
 * this leaf module breaks it.
 *
 * Titles are i18n *keys*, not text: a plain module resolves nothing at import
 * time, so storing translated strings here would freeze the language that
 * happened to be active at load. Components resolve the key with `t()`.
 */
import type { MessageKey } from "../i18n";

export interface PanelTypeInfo {
  type: string;
  titleKey: MessageKey;
}

export const panelTypes: PanelTypeInfo[] = [
  { type: "issue.list", titleKey: "panelTitle.issue.list" },
  { type: "issue.detail", titleKey: "panelTitle.issue.detail" },
  { type: "pull.list", titleKey: "panelTitle.pull.list" },
  { type: "pull.detail", titleKey: "panelTitle.pull.detail" },
];
