/**
 * CM6 的 Markdown 视觉样式 + live-preview 标记隐藏 —— **逐文件对照移植**自 SoloMD
 * （`src/lib/cm-live-preview.ts`，MIT，Copyright (c) 2026 xiangdong li），
 * 按我们的 token 体系改写（HiveTask 注：字号一律走 `--font-*`，颜色走 `--text/--accent/...`）。
 *
 * 形态：Typora 式——光标不在的行把 Markdown 记号（`#`、`**`、`~~`）藏起来，
 * 光标进入该行即刻显形可编辑；文档缓冲始终是纯 Markdown 源文本。
 *
 * 与 SoloMD 的差异（③适配）：
 * - 保留 `LinkMark`/`CodeMark` 可见（与 SoloMD 一致：藏掉会让链接与行内代码失去视觉提示）；
 * - 样式落到本仓库 token，明暗主题自动跟随（`--text` 等已是主题变量）。
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { fullSyntaxTree } from "./tree";
import type { SyntaxNodeRef } from "@lezer/common";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { frozenDuringComposition } from "./ime-guard";
import { liveRenderTheme, renderItems } from "./live-render";
import { imageItems } from "./image";

/** 隐藏记号（光标不在其所在行时）—— 与 SoloMD 的集合一致。 */
const HIDDEN_MARK_NODES = new Set(["HeaderMark", "EmphasisMark", "StrikethroughMark"]);

const hideDeco = Decoration.replace({});

const lineDecorations: Record<string, Decoration> = {
  h1: Decoration.line({ class: "cm-md-h1" }),
  h2: Decoration.line({ class: "cm-md-h2" }),
  h3: Decoration.line({ class: "cm-md-h3" }),
  h4: Decoration.line({ class: "cm-md-h4" }),
  quote: Decoration.line({ class: "cm-md-quote" }),
  code: Decoration.line({ class: "cm-md-codeline" }),
};

interface NodeInfo {
  name: string;
  from: number;
  to: number;
  lineFrom: number;
}

/** 该行是否被选区触及（光标所在行不隐藏记号）。 */
function lineTouched(state: EditorState, lineFrom: number, lineTo: number): boolean {
  return state.selection.ranges.some((r) => r.from <= lineTo && r.to >= lineFrom);
}

export function buildDecorations(state: EditorState): DecorationSet {
  const doc = state.doc;
  const tree = fullSyntaxTree(state);
  const items: { from: number; to: number; deco: Decoration }[] = [];
  const treeNodes: NodeInfo[] = [];
  tree.iterate({
    enter: (node: SyntaxNodeRef) => {
      treeNodes.push({
        name: node.name,
        from: node.from,
        to: node.to,
        lineFrom: doc.lineAt(node.from).from,
      });
    },
  });

  for (const node of treeNodes) {
    const line = doc.lineAt(node.lineFrom);
    const touched = lineTouched(state, line.from, line.to);

    if (!touched && HIDDEN_MARK_NODES.has(node.name)) {
      // 替换型：范围化零宽（`#`、`**`、`~~` 都不会跨行）
      items.push({ from: node.from, to: node.to, deco: hideDeco });
      continue;
    }
    // 块级行的样式（标题变大、引用缩进、代码块底色）：零宽，钉在行首
    if (node.name.startsWith("ATXHeading")) {
      const level = node.name.replace("ATXHeading", "");
      const deco = lineDecorations[`h${level}`];
      if (deco) items.push({ from: node.lineFrom, to: node.lineFrom, deco });
    }
    if (node.name === "Blockquote") items.push({ from: node.lineFrom, to: node.lineFrom, deco: lineDecorations.quote });
    if (node.name === "FencedCode") items.push({ from: node.lineFrom, to: node.lineFrom, deco: lineDecorations.code });
  }

  // 行内 widget（圆点/待办/分隔线）与记号隐藏合并成一套装饰
  items.push(...renderItems(state));
  items.push(...imageItems(state));

  // Decoration.set(..., true) 自行排序；同位置时 line 装饰必须先于 replace
  // （CM6 要求：同一位置的 line 装饰在任何其它装饰之前）。
  items.sort((a, b) => a.from - b.from || Number(b.deco.spec?.block ?? false) - Number(a.deco.spec?.block ?? false));
  return Decoration.set(
    items.map((i) => i.deco.range(i.from, i.to)),
    true,
  );
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view.state);
    }
    update(update: ViewUpdate) {
      // 组字期间冻结（只 map），避免拆掉正在输入的 DOM —— IME 守卫
      const frozen = frozenDuringComposition(update, this.decorations);
      if (frozen) {
        this.decorations = frozen;
        return;
      }
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.state);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/** 富文本样式（标题/粗斜体/行内代码/链接/引用/代码块）。 */
export const markdownRichStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.5em", fontWeight: "700", lineHeight: "1.4" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "600" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.monospace, t.special(t.string)], fontFamily: "var(--kb-mono)", color: "var(--accent)" },
  { tag: t.link, color: "var(--accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--text-dim)" },
  { tag: t.quote, color: "var(--text-dim)", fontStyle: "italic" },
  { tag: t.list, color: "var(--text)" },
  { tag: t.contentSeparator, color: "var(--border)" },
]);

/** 编辑区样式：正文档字号 + 行距，随主题 token 走。 */
const editorTheme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "var(--bg-panel)", fontSize: "var(--font-base)" },
  ".cm-content": {
    fontFamily: "var(--kb-sans)",
    lineHeight: "1.7",
    // 面板**外层**白边为 0（内容贴边铺满，见 KnowledgePreview 的 .editor-active）；
    // 这里保留**内容内边距**：0 会让文字紧贴行号与右边缘，读起来发闷。
    // 取值参照文档式编辑器的克制档（两侧 24、上 10、下 48 便于滚过末行）。
    padding: "10px 24px 48px",
    caretColor: "var(--accent)",
  },
  ".cm-scroller": { fontFamily: "inherit", overflow: "auto" },
  "&.cm-focused": { outline: "none" },
  ".cm-line": { padding: "0" },
  ".cm-md-quote": { borderLeft: "3px solid var(--border)", paddingLeft: "10px", color: "var(--text-dim)" },
  ".cm-md-codeLine, .cm-md-codeline": {
    backgroundColor: "var(--bg-app)",
    fontFamily: "var(--kb-mono)",
  },
  // 行号栏：CM6 默认用的是它自己的 &light/&dark 配色（我们没告诉它主题时会按 light 走，
  // 深色下就是一条浅色栏）——这里改成我们的 token，明暗自适应。
  ".cm-gutters": {
    backgroundColor: "var(--bg-panel)",
    color: "var(--text-dim)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 6px", minWidth: "28px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 8%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent-soft)",
  },
});

export const livePreview: Extension = [
  livePreviewPlugin,
  syntaxHighlighting(markdownRichStyle),
  editorTheme,
  liveRenderTheme,
];
