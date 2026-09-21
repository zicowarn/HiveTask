/**
 * CM6 侧的命令实现：把 `markdown-tools.ts` 的命令表作用到编辑器缓冲。
 *
 * 与 Issue 编辑器的差别：那里是 textarea（`setSelectionRange`），这里是 CM6 事务——
 * 好处是天然进撤销历史、支持多光标、选区自动归一化。
 */
import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import { redo, undo } from "@codemirror/commands";
import type { EditorView, KeyBinding } from "@codemirror/view";
import { commandByKey, type MarkdownCommand } from "../../components/markdown-tools";

/** 包裹选区（粗体/斜体/行内代码/链接/图片）；空选区时用占位文本并选中它。 */
function wrap(view: EditorView, prefix: string, suffix: string, placeholder: string): boolean {
  const changes: ChangeSpec[] = [];
  const ranges = view.state.selection.ranges.map((range) => {
    const selected = view.state.sliceDoc(range.from, range.to);
    const body = selected || placeholder;
    changes.push({ from: range.from, to: range.to, insert: `${prefix}${body}${suffix}` });
    // 选中"内容本身"（不含包裹记号），方便直接替换输入
    const from = range.from + prefix.length;
    return EditorSelection.range(from, from + body.length);
  });
  view.dispatch({ changes, selection: EditorSelection.create(ranges) });
  view.focus();
  return true;
}

/** 行首前缀（标题/引用/列表/任务）。 */
function prefixLine(view: EditorView, token: string): boolean {
  const changes: ChangeSpec[] = [];
  for (const range of view.state.selection.ranges) {
    const line = view.state.doc.lineAt(range.from);
    changes.push({ from: line.from, to: line.from, insert: token });
  }
  view.dispatch({ changes });
  view.focus();
  return true;
}

/** 插入整块文本；`$1` 标记插入后的光标落点。 */
function insertBlock(view: EditorView, text: string): boolean {
  const marker = text.indexOf("$1");
  const body = marker >= 0 ? text.slice(0, marker) + text.slice(marker + 2) : text;
  const range = view.state.selection.main;
  // 光标不在行首时先补一个换行，避免把块塞进当前行中间
  const line = view.state.doc.lineAt(range.from);
  const needsBreak = range.from > line.from ? "\n" : "";
  const insert = `${needsBreak}${body}`;
  const cursor = range.from + needsBreak.length + (marker >= 0 ? marker : body.length);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(cursor),
  });
  view.focus();
  return true;
}

/** 执行一条命令；返回是否处理（`false` 时键位可继续冒泡）。 */
export function runCommand(view: EditorView, command: MarkdownCommand): boolean {
  switch (command.kind) {
    case "wrap":
      return wrap(view, command.prefix ?? "", command.suffix ?? "", command.placeholder ?? "");
    case "line":
      return prefixLine(view, command.token ?? "");
    case "insert":
      return insertBlock(view, command.text ?? "");
    case "action":
      if (command.key === "undo") return undo(view);
      return false;
    default:
      return false;
  }
}

export function runCommandByKey(view: EditorView, key: string): boolean {
  const command = commandByKey(key);
  return command ? runCommand(view, command) : false;
}

/**
 * 快捷键：沿用 Typora 的通行方案，避开本应用已占用的 ⌘1..5 / ⌘R / ⌘O / ⌘,。
 * 标题级别用 ⌘⌥1..6（⌃1..6 被 macOS 切换桌面占用）。
 */
export const markdownKeymap: KeyBinding[] = [
  { key: "Mod-b", run: (view: EditorView) => runCommandByKey(view, "b") },
  { key: "Mod-i", run: (view: EditorView) => runCommandByKey(view, "i") },
  { key: "Mod-k", run: (view: EditorView) => runCommandByKey(view, "link") },
  { key: "Mod-Shift-k", run: (view: EditorView) => runCommandByKey(view, "code") },
  { key: "Alt-Mod-q", run: (view: EditorView) => runCommandByKey(view, "quote") },
  { key: "Alt-Mod-u", run: (view: EditorView) => runCommandByKey(view, "ul") },
  { key: "Alt-Mod-o", run: (view: EditorView) => runCommandByKey(view, "ol") },
  { key: "Alt-Mod-x", run: (view: EditorView) => runCommandByKey(view, "task") },
  { key: "Alt-Mod-b", run: (view: EditorView) => runCommandByKey(view, "formula") },
  ...Array.from({ length: 6 }, (_unused, index) => ({
    key: `Alt-Mod-${index + 1}`,
    run: (view: EditorView): boolean => prefixLine(view, `${"#".repeat(index + 1)} `),
  })),
  { key: "Mod-Shift-z", run: redo },
];

/** 右键菜单（与工具条同一份命令表；分组见 COMMAND_GROUPS）。 */
export const CONTEXT_MENU_GROUPS = [
  ["b", "i", "code", "link"],
  ["h", "quote", "ul", "ol", "task"],
  ["image", "table", "formula"],
  ["undo"],
];

export { commandByKey };
