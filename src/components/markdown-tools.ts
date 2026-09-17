/**
 * Markdown 编辑命令的**单一事实源**：工具条、快捷键、右键菜单都从这里取。
 *
 * 图标一律 Octicon（`o.md-*` 与 `o.*` 族，路径取自平台页面/官方包，见 AGENTS.md 图标铁律）。
 * 快捷键沿用 Typora 的通行方案，但避开本应用已占用的键：
 * - `⌘1..5` 是工作区页签 → 标题级别改用 **`⌘⌥1..6`**；
 * - `⌃1..6` 被 macOS 的「切换桌面」占用 → 同样不用；
 * - `⌘R`（刷新）/`⌘O`（打开仓库）/`⌘,`（设置）已有归属 → 命令表不使用。
 */
import type { MessageKey } from "../i18n";

export type CommandKind = "wrap" | "line" | "insert" | "action";

export interface MarkdownCommand {
  key: string;
  kind: CommandKind;
  icon: string;
  labelKey: MessageKey;
  /** 展示用快捷键（keymap 的实现见 editor/commands.ts，两处保持同一套）。 */
  shortcut?: string;
  /** wrap：包裹前缀/后缀与占位文本。 */
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  /** line：行首前缀（标题/引用/列表）。 */
  token?: string;
  /** insert：插入的整块文本（`$1` 表示插入后光标落点）。 */
  text?: string;
}

/** 全量命令表（各宿主用 `keys` 选取自己需要的子集）。 */
export const MARKDOWN_COMMANDS: MarkdownCommand[] = [
  { key: "h", kind: "line", icon: "o.md-heading", labelKey: "md.heading", shortcut: "⌘⌥1", token: "## " },
  { key: "b", kind: "wrap", icon: "o.md-bold", labelKey: "md.bold", shortcut: "⌘B", prefix: "**", suffix: "**", placeholder: "bold text" },
  { key: "i", kind: "wrap", icon: "o.md-italic", labelKey: "md.italic", shortcut: "⌘I", prefix: "*", suffix: "*", placeholder: "italic text" },
  { key: "quote", kind: "line", icon: "o.md-quote", labelKey: "md.quote", shortcut: "⌥⌘Q", token: "> " },
  { key: "code", kind: "wrap", icon: "o.md-code", labelKey: "md.code", shortcut: "⌘⇧K", prefix: "`", suffix: "`", placeholder: "code" },
  { key: "link", kind: "wrap", icon: "o.md-link", labelKey: "md.link", shortcut: "⌘K", prefix: "[", suffix: "](url)", placeholder: "text" },
  { key: "ul", kind: "line", icon: "o.md-list-unordered", labelKey: "md.ul", shortcut: "⌥⌘U", token: "- " },
  { key: "ol", kind: "line", icon: "o.md-list-ordered", labelKey: "md.ol", shortcut: "⌥⌘O", token: "1. " },
  { key: "task", kind: "line", icon: "o.md-tasklist", labelKey: "md.task", shortcut: "⌥⌘X", token: "- [ ] " },
  { key: "image", kind: "wrap", icon: "o.md-image", labelKey: "md.image", prefix: "![", suffix: "](url)", placeholder: "alt" },
  { key: "table", kind: "insert", icon: "o.layout-table", labelKey: "md.table", text: "| 列一 | 列二 |\n| --- | --- |\n|  |  |\n" },
  { key: "formula", kind: "insert", icon: "o.formula", labelKey: "md.formula", shortcut: "⌥⌘B", text: "$$\n$1\n$$\n" },
  { key: "toc", kind: "insert", icon: "o.list-ordered", labelKey: "md.toc", text: "- 目录\n$1" },
  { key: "mention", kind: "wrap", icon: "o.md-mention", labelKey: "md.mention", prefix: "@", suffix: "", placeholder: "user" },
  { key: "undo", kind: "action", icon: "o.md-undo", labelKey: "md.undo", shortcut: "⌘Z" },
];

/** 分组（工具条用竖线分隔；与 GitHub 工具条的分组分隔视觉一致）。 */
export const COMMAND_GROUPS: string[][] = [
  ["h", "b", "i", "quote", "code", "link"],
  ["ul", "ol", "task"],
  ["image", "table", "formula", "toc"],
  ["undo"],
];

/** Issue/评论编辑器用的键序（与既有 12 键完全一致，保证形态不变）。 */
export const ISSUE_TOOLBAR_KEYS = ["h", "b", "i", "quote", "code", "link", "ul", "ol", "task", "image", "mention", "undo"];

/** 知识库编辑器用的分组（去掉 @提及，加入表格/公式/目录）。 */
export const EDITOR_COMMAND_GROUPS: string[][] = [
  ["h", "b", "i", "quote", "code", "link"],
  ["ul", "ol", "task"],
  ["image", "table", "formula", "toc"],
  ["undo"],
];

export function commandByKey(key: string): MarkdownCommand | undefined {
  return MARKDOWN_COMMANDS.find((c) => c.key === key);
}
