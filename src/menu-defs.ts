/**
 * Menu structure — plain data shared by the two menu surfaces: the native
 * application menu (src/native-menu.ts, used inside Tauri) and the
 * in-header AppMenu fallback (browser preview, where no system menubar
 * exists).
 *
 * Built through buildMenuDefs(t, actions) inside a Vue computed: t() reads
 * locale on every call, so a language switch re-runs it and the native menu
 * gets rebuilt with translated labels. Shortcut display strings ("⌘O") are
 * translated to native accelerator strings by native-menu.ts.
 */
import { t } from "./i18n";

export interface MenuItemDef {
  label?: string;
  /** Display form, e.g. "⌘O". */
  shortcut?: string;
  action?: () => void;
  /** Present → rendered as a checkable item with this state. */
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export interface MenuDef {
  label: string;
  items: MenuItemDef[];
}

export interface MenuActions {
  pickRepo(): void;
  refresh(): void;
  refreshDisabled(): boolean;
  openPreferences(): void;
  gotoIssues(): void;
  gotoPulls(): void;
  gotoProjects(): void;
  gotoKnowledge(): void;
  gotoTools(): void;
  statusbarVisible(): boolean;
  toggleStatusbar(): void;
  githubUrlMissing(): boolean;
  openInGithub(): void;
  copyUrl(): void;
  openAbout(): void;
}

export function buildMenuDefs(a: MenuActions): MenuDef[] {
  return [
    {
      label: t("menu.file"),
      items: [
        { label: t("menu.openRepo"), shortcut: "⌘O", action: a.pickRepo },
        {
          label: t("common.refresh"),
          shortcut: "⌘R",
          action: a.refresh,
          disabled: a.refreshDisabled(),
        },
        { separator: true },
        { label: t("menu.preferences"), shortcut: "⌘,", action: a.openPreferences },
      ],
    },
    {
      label: t("menu.view"),
      items: [
        { label: t("menu.issues"), shortcut: "⌘1", action: a.gotoIssues },
        { label: t("menu.pulls"), shortcut: "⌘2", action: a.gotoPulls },
        { label: t("workspace.projects"), shortcut: "⌘4", action: a.gotoProjects },
        { label: t("workspace.knowledge"), shortcut: "⌘5", action: a.gotoKnowledge },
        { label: t("workspace.tools"), shortcut: "⌘3", action: a.gotoTools },
        { separator: true },
        {
          label: t("menu.toggleStatusbar"),
          checked: a.statusbarVisible(),
          action: a.toggleStatusbar,
        },
      ],
    },
    {
      label: t("menu.tools"),
      items: [
        {
          label: t("common.openInGithub"),
          shortcut: "⌘⇧O",
          action: a.openInGithub,
          disabled: a.githubUrlMissing(),
        },
        {
          label: t("menu.copyUrl"),
          shortcut: "⌘⇧C",
          action: a.copyUrl,
          disabled: a.githubUrlMissing(),
        },
      ],
    },
    {
      label: t("menu.help"),
      items: [{ label: t("menu.about"), action: a.openAbout }],
    },
  ];
}
