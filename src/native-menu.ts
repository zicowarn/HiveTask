/**
 * Native application menu (macOS menubar / Windows & Linux taskbar menu),
 * built from the same buildMenuDefs() data as the in-header fallback.
 *
 * Tauri installs an English default menu when none is set; we replace it
 * wholesale on every sync so the menubar is fully ours: an app submenu
 * (About → our About dialog, plus system Hide/Quit roles), an Edit submenu
 * with the standard text-editing roles (without them ⌘C/⌘V die in the
 * webview), then the four app submenus.
 *
 * The whole menu is rebuilt on each sync — language switches and state
 * changes (checkmarks, disabled items) are just another rebuild. Cheap at
 * this size and stateless. Requires no Rust side: core:default already
 * grants core:menu:default.
 */
import {
  CheckMenuItem,
  Menu,
  MenuItem,
  PredefinedMenuItem,
  Submenu,
} from "@tauri-apps/api/menu";
import { t } from "./i18n";
import type { MenuDef, MenuItemDef } from "./menu-defs";

/** "⌘⇧O" → "Cmd+Shift+O"; "⌘," → "Cmd+,". */
function toAccelerator(shortcut: string): string {
  const parts: string[] = [];
  if (shortcut.includes("⌃")) parts.push("Ctrl");
  if (shortcut.includes("⌥")) parts.push("Alt");
  if (shortcut.includes("⇧")) parts.push("Shift");
  if (shortcut.includes("⌘")) parts.push("Cmd");
  const key = shortcut.replace(/[⌘⇧⌥⌃]/g, "");
  if (key) parts.push(key);
  return parts.join("+");
}

async function buildItem(item: MenuItemDef): Promise<
  ReturnType<typeof MenuItem.new> | ReturnType<typeof CheckMenuItem.new> | ReturnType<typeof PredefinedMenuItem.new>
> {
  if (item.separator) {
    return PredefinedMenuItem.new({ item: "Separator" });
  }
  const opts = {
    text: item.label ?? "",
    enabled: !item.disabled,
    accelerator: item.shortcut ? toAccelerator(item.shortcut) : undefined,
    action: () => item.action?.(),
  };
  return item.checked !== undefined
    ? CheckMenuItem.new({ ...opts, checked: item.checked })
    : MenuItem.new(opts);
}

async function buildSubmenu(def: MenuDef) {
  const items = await Promise.all(def.items.map(buildItem));
  return Submenu.new({ text: def.label, items });
}

/** System roles every desktop app needs; labels follow OS conventions. */
async function buildEditSubmenu() {
  const items = await Promise.all([
    PredefinedMenuItem.new({ item: "Undo", text: t("menu.undo") }),
    PredefinedMenuItem.new({ item: "Redo", text: t("menu.redo") }),
    PredefinedMenuItem.new({ item: "Separator" }),
    PredefinedMenuItem.new({ item: "Cut", text: t("menu.cut") }),
    PredefinedMenuItem.new({ item: "Copy", text: t("menu.copy") }),
    PredefinedMenuItem.new({ item: "Paste", text: t("menu.paste") }),
    PredefinedMenuItem.new({ item: "Separator" }),
    PredefinedMenuItem.new({ item: "SelectAll", text: t("menu.selectAll") }),
  ]);
  return Submenu.new({ text: t("menu.edit"), items });
}

/** App submenu: About (our dialog) + system Hide/Services/Quit roles. */
async function buildAppSubmenu(about: () => void) {
  const items = await Promise.all([
    MenuItem.new({ text: t("menu.about"), action: about }),
    PredefinedMenuItem.new({ item: "Separator" }),
    PredefinedMenuItem.new({ item: "Services", text: t("menu.services") }),
    PredefinedMenuItem.new({ item: "Separator" }),
    PredefinedMenuItem.new({ item: "Hide", text: t("menu.hide") }),
    PredefinedMenuItem.new({ item: "HideOthers", text: t("menu.hideOthers") }),
    PredefinedMenuItem.new({ item: "ShowAll", text: t("menu.showAll") }),
    PredefinedMenuItem.new({ item: "Separator" }),
    PredefinedMenuItem.new({ item: "Quit", text: t("menu.quit") }),
  ]);
  return Submenu.new({ text: "HiveTask", items });
}

/** Replace the application menu wholesale. Safe to call repeatedly. */
export async function syncApplicationMenu(
  defs: MenuDef[],
  about: () => void,
): Promise<void> {
  const [appSub, editSub, ...defSubs] = await Promise.all([
    buildAppSubmenu(about),
    buildEditSubmenu(),
    ...defs.map(buildSubmenu),
  ]);
  // macOS convention: <App>, File, Edit, then the rest (View/Tools/Help).
  const [fileSub, ...rest] = defSubs;
  const items = fileSub ? [appSub, fileSub, editSub, ...rest] : [appSub, editSub, ...rest];
  const menu = await Menu.new({ items });
  await menu.setAsAppMenu();
}
