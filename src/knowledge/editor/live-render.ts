/**
 * 行内 widget：无序列表圆点 / 待办复选框 / 分隔线 —— **逐文件对照移植**自 SoloMD
 * （`src/lib/cm-live-render.ts`，MIT，Copyright (c) 2026 xiangdong li），
 * 按我们的形态与 token 改写（HiveTask 注：复选框不用输入法字体里的符号，用自绘方框 + SVG 勾，
 * 免得不同平台字体把 ☑/☐ 渲染成方框或彩色 emoji）。
 *
 * 光标所在行一律保持源码（可编辑），与 live-preview 的记号显隐同一口径。
 *
 * 注：@codemirror/lang-markdown 把 `- [ ]` 解析成 ListMark + Paragraph（**没有** Task 节点），
 * 所以待办靠"标记后的文本形态"识别，不依赖语法树节点名。
 */
import { fullSyntaxTree } from "./tree";
import type { SyntaxNodeRef } from "@lezer/common";
import { EditorView, WidgetType, Decoration } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";

export interface RenderItem {
  from: number;
  to: number;
  deco: Decoration;
}

function cursorTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/** 无序列表的圆点（替掉 `-` / `*` / `+`）。 */
class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-kb-bullet";
    span.textContent = "•";
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** 待办复选框：点击即切换 `[ ]` ↔ `[x]`（写回源文本，不引入隐藏状态）。 */
class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number) {
    super();
  }
  eq(other: TaskWidget): boolean {
    return other.checked === this.checked && other.from === this.from;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("span");
    box.className = "cm-kb-task";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    if (this.checked) {
      box.innerHTML =
        '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-6.5 6.5a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06l2.47 2.47 5.97-5.97a.75.75 0 0 1 1.06 0Z"/></svg>';
    }
    const markFrom = this.from;
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({
        changes: { from: markFrom, to: markFrom + 3, insert: this.checked ? "[ ]" : "[x]" },
      });
    });
    return box;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** 分隔线：`---` 独占一行时画一条线（不用字体里的制表符）。 */
class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-kb-rule";
    return div;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** 标记之后：可选空格 + `[ ]`/`[x]` + 空格。 */
const TASK_RE = /^(\s*)\[([ xX])\](\s)/;

export function renderItems(state: EditorState): RenderItem[] {
  const items: RenderItem[] = [];
  const doc = state.doc;
  const tree = fullSyntaxTree(state);

  tree.iterate({
    enter: (node: SyntaxNodeRef) => {
      if (node.name === "HorizontalRule") {
        const line = doc.lineAt(node.from);
        if (!cursorTouches(state, line.from, line.to)) {
          items.push({ from: line.from, to: line.to, deco: Decoration.replace({ widget: new RuleWidget() }) });
        }
        return;
      }
      if (node.name !== "ListMark") return;
      const mark = doc.sliceString(node.from, node.to);
      // 有序列表的数字是有信息量的，保持原样
      if (!/^[-*+]$/.test(mark)) return;

      const line = doc.lineAt(node.from);
      const after = doc.sliceString(node.to, line.to);
      const task = TASK_RE.exec(after);
      if (cursorTouches(state, line.from, line.to)) return;

      if (task) {
        const checked = task[2].toLowerCase() === "x";
        // `[` 的落点 = 标记末尾 + 前导空格数
        const bracketFrom = node.to + task[1].length;
        // 连标记带 `[ ]` 一起换个复选框：`- [ ] ` → ☐（点击切换写回源文本）
        items.push({
          from: node.from,
          to: bracketFrom + 3,
          deco: Decoration.replace({ widget: new TaskWidget(checked, bracketFrom) }),
        });
      } else {
        items.push({ from: node.from, to: node.to, deco: Decoration.replace({ widget: new BulletWidget() }) });
      }
    },
  });

  items.sort((a, b) => a.from - b.from);
  return items;
}

export const liveRenderTheme = EditorView.baseTheme({
  ".cm-kb-bullet": { color: "var(--accent)", paddingRight: "2px" },
  ".cm-kb-task": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "13px",
    height: "13px",
    marginRight: "2px",
    verticalAlign: "-2px",
    border: "1px solid var(--text-dim)",
    borderRadius: "3px",
    cursor: "pointer",
    color: "transparent",
  },
  ".cm-kb-task[aria-checked='true']": {
    backgroundColor: "var(--accent)",
    borderColor: "var(--accent)",
    color: "#fff",
  },
  ".cm-kb-rule": {
    display: "block",
    height: "1px",
    backgroundColor: "var(--border)",
    margin: "8px 0",
  },
});
