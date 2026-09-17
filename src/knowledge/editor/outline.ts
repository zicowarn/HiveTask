/**
 * 大纲：从 CM6 语法树提取标题（ATX 与 Setext 两种写法），供大纲面板渲染与跳转。
 *
 * 用语法树而不是正则：`#` 出现在代码块/引用里不会被误判为标题。
 */
import { fullSyntaxTree } from "./tree";
import type { SyntaxNodeRef } from "@lezer/common";
import type { EditorState } from "@codemirror/state";

export interface OutlineItem {
  /** 1..6 */
  level: number;
  text: string;
  /** 0 基的行号（跳转与"当前章节"判定都用它）。 */
  line: number;
}

const ATX = /^ATXHeading(\d)$/;

export function buildOutline(state: EditorState): OutlineItem[] {
  const items: OutlineItem[] = [];
  fullSyntaxTree(state).iterate({
    enter: (node: SyntaxNodeRef) => {
      const atx = ATX.exec(node.name);
      const setext = node.name === "SetextHeading1" || node.name === "SetextHeading2";
      if (!atx && !setext) return;
      const level = atx ? Number(atx[1]) : Number(node.name.slice(-1));
      const line = state.doc.lineAt(node.from);
      // 去掉行首记号：`## 标题` → `标题`；Setext 的下划线行不属于标题文本
      const raw = state.doc.sliceString(node.from, node.to).split("\n")[0];
      const text = raw
        .replace(/^\s{0,3}#{1,6}\s*/, "")
        .replace(/\s*#+\s*$/, "")
        .trim();
      if (!text) return;
      items.push({ level, text, line: line.number - 1 });
    },
  });
  return items;
}

/** 光标所在行对应的"当前章节"（最后一个起始行 ≤ 光标行的标题）。 */
export function activeOutlineIndex(items: OutlineItem[], cursorLine: number | null): number {
  if (cursorLine === null || items.length === 0) return -1;
  let active = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].line <= cursorLine) active = i;
    else break;
  }
  return active;
}
