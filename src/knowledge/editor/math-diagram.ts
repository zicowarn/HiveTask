/**
 * 块级 widget：KaTeX 公式与 Mermaid 图 —— **逐文件对照移植**自 SoloMD
 * （`src/lib/cm-live-blocks.ts` 的公式/Mermaid 两段，MIT，Copyright (c) 2026 xiangdong li）。
 *
 * HiveTask 注：
 * - 只在光标**不在**该块内时折叠为渲染结果；光标进入即回到源码（可编辑）；
 * - mermaid 结果按源码字符串缓存；渲染失败把错误信息渲染出来而不是吞掉；
 * - **无任何远程资源**：`securityLevel: "strict"`、不加载外部字体与图标（离线硬约束）。
 */
import { fullSyntaxTree } from "./tree";
import type { SyntaxNodeRef } from "@lezer/common";
import { tableItems, tableTheme } from "./table";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import katex from "katex";
import "katex/dist/katex.css";

type DecorationItem = { from: number; to: number; deco: Decoration };

/** 行内公式 `$...$`：一对 `$` 内无换行、且不是 `$$`。 */
const INLINE_MATH = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;

export class KatexWidget extends WidgetType {
  constructor(readonly tex: string, readonly display: boolean) {
    super();
  }
  eq(other: KatexWidget): boolean {
    return other.tex === this.tex && other.display === this.display;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = this.display ? "cm-katex cm-katex-block" : "cm-katex";
    try {
      katex.render(this.tex, span, { displayMode: this.display, throwOnError: false });
    } catch (e) {
      span.className = "cm-katex-error";
      span.textContent = String(e);
    }
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** mermaid SVG 缓存：同一份源码只渲染一次。 */
const mermaidCache = new Map<string, { svg: string | null; error: string | null }>();
let mermaidSeq = 0;
let mermaidLoading: Promise<typeof import("mermaid").default> | null = null;

async function loadMermaid() {
  mermaidLoading ||= import("mermaid").then((m) => m.default);
  const mermaid = await mermaidLoading;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // 跟随主题（dark/light 由 body 的 data-theme 决定）
    theme: document.documentElement.dataset.theme === "light" ? "default" : "dark",
    fontFamily: "inherit",
  });
  return mermaid;
}

async function renderMermaid(source: string): Promise<{ svg: string | null; error: string | null }> {
  const cached = mermaidCache.get(source);
  if (cached) return cached;
  mermaidCache.set(source, { svg: null, error: null });
  try {
    const mermaid = await loadMermaid();
    const { svg } = await mermaid.render(`kb-mmd-${++mermaidSeq}`, source);
    const entry = { svg, error: null };
    mermaidCache.set(source, entry);
    return entry;
  } catch (e) {
    const entry = { svg: null, error: (e as Error).message };
    mermaidCache.set(source, entry);
    return entry;
  }
}

export class MermaidWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: MermaidWidget): boolean {
    return other.source === this.source;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-mermaid";
    const cached = mermaidCache.get(this.source);
    const paint = (entry: { svg: string | null; error: string | null }) => {
      if (entry.svg) {
        wrap.innerHTML = entry.svg;
      } else if (entry.error) {
        wrap.classList.add("cm-mermaid-error");
        wrap.textContent = entry.error;
      } else {
        wrap.textContent = "正在渲染…";
      }
      view.requestMeasure();
    };
    if (cached) {
      paint(cached);
    } else {
      wrap.textContent = "正在渲染…";
      void renderMermaid(this.source).then(paint);
    }
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** 该位置是否落在代码块/行内代码里（公式与围栏都不应在其中被识别）。 */
function insideCode(state: EditorState, pos: number): boolean {
  let node = fullSyntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "InlineCode") return true;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

function cursorIn(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/**
 * 公式与 Mermaid 的折叠渲染。作为 ViewPlugin 的 decorations 提供者接进编辑器。
 */
export function mathAndDiagramDecorations(state: EditorState, onTableEdit?: () => void): DecorationSet {
  const doc = state.doc;
  const items: DecorationItem[] = [];
  const tree = fullSyntaxTree(state);

  // ---- 围栏代码块：```mermaid → 渲染成图 ----
  tree.iterate({
    enter: (node: SyntaxNodeRef) => {
      if (node.name !== "FencedCode") return;
      const text = doc.sliceString(node.from, node.to);
      const firstLineEnd = text.indexOf("\n");
      const info = (firstLineEnd >= 0 ? text.slice(0, firstLineEnd) : text).replace(/^```+\s*/, "").trim().toLowerCase();
      if (info !== "mermaid" && info !== "mmd") return;
      if (cursorIn(state, node.from, node.to)) return; // 光标在内 → 显示源码
      const body = text
        .slice(firstLineEnd + 1)
        .replace(/```+\s*$/, "")
        .trim();
      if (!body) return;
      const first = doc.lineAt(node.from);
      const last = doc.lineAt(node.to);
      // 跨行替换：block: true + 整行范围（CM6 硬性要求，且只能来自 state facet）
      items.push({
        from: first.from,
        to: last.to,
        deco: Decoration.replace({ block: true, widget: new MermaidWidget(body) }),
      });
    },
  });

  // ---- 行内与块级公式 ----
  // 跨行块级公式（`$$` 独占一行 … 闭合 `$$` 独占一行）先扫一遍，再做逐行处理。
  let blockStart = 1;
  while (blockStart <= doc.lines) {
    const line = doc.line(blockStart);
    if (line.text.trim() !== "$$" || insideCode(state, line.from)) {
      blockStart += 1;
      continue;
    }
    let endLine = blockStart + 1;
    while (endLine <= doc.lines && doc.line(endLine).text.trim() !== "$$") endLine += 1;
    if (endLine > doc.lines) {
      blockStart += 1; // 未闭合：当普通文本
      continue;
    }
    const closeLine = doc.line(endLine);
    const tex = doc.sliceString(line.to, closeLine.from).trim();
    if (tex && !cursorIn(state, line.from, closeLine.to)) {
      items.push({
        from: line.from,
        to: closeLine.to,
        deco: Decoration.replace({ block: true, widget: new KatexWidget(tex, true) }),
      });
    }
    blockStart = endLine + 1;
  }

  for (let i = 1; i <= doc.lines; i += 1) {
    const line = doc.line(i);
    if (insideCode(state, line.from)) continue;
    const text = line.text;
    // 单行形态：整行 $$…$$
    const block = text.match(/^\s*\$\$(.+?)\$\$\s*$/);
    if (block && !cursorIn(state, line.from, line.to)) {
      items.push({
        from: line.from,
        to: line.to,
        deco: Decoration.replace({ block: true, widget: new KatexWidget(block[1].trim(), true) }),
      });
      continue;
    }
    for (const match of text.matchAll(INLINE_MATH)) {
      const tex = match[1].trim();
      if (!tex) continue;
      const from = line.from + (match.index ?? 0);
      const to = from + match[0].length;
      if (cursorIn(state, from, to)) continue;
      items.push({ from, to, deco: Decoration.replace({ widget: new KatexWidget(tex, false) }) });
    }
  }

  items.push(...tableItems(state, onTableEdit));
  // 块级装饰必须排在非块级之前（同位置时）
  items.sort((a, b) => a.from - b.from || Number(b.deco.spec?.block ?? false) - Number(a.deco.spec?.block ?? false));
  return Decoration.set(
    items.map((i) => i.deco.range(i.from, i.to)),
    true,
  );
}

export const mathAndDiagramTheme = EditorView.baseTheme({
  ".cm-katex": { padding: "0 1px" },
  ".cm-katex-block": { display: "block", textAlign: "center", padding: "6px 0" },
  ".cm-katex-error": { color: "var(--danger)", fontFamily: "var(--kb-mono)", fontSize: "var(--font-sm)" },
  ".cm-mermaid": {
    display: "block",
    padding: "8px 0",
    textAlign: "center",
    backgroundColor: "var(--bg-app)",
    borderRadius: "6px",
  },
  ".cm-mermaid svg": { maxWidth: "100%", height: "auto" },
  ".cm-mermaid-error": { color: "var(--danger)", fontFamily: "var(--kb-mono)", fontSize: "var(--font-sm)" },
});

/** 需要它时把它放进编辑器扩展列表（与 live-preview 并列）。`onTableEdit`：渲染态表格的编辑入口。 */
export function mathAndDiagram(onTableEdit?: () => void): Extension {
  return [
    // 跨行替换（表格 / 围栏 / 块级公式）必须由 state facet 提供，故整组放这里
    EditorView.decorations.compute(["doc", "selection"], (state) => mathAndDiagramDecorations(state, onTableEdit)),
    mathAndDiagramTheme,
    tableTheme,
    // 渲染态单元格直接编辑的写回通道（TableWidget 发 kb:table-writeback）
    EditorView.domEventHandlers({}),
    viewPluginBridge(),
  ];
}

/** 把 widget 的写回事件接进 CM6 事务（view 只在这里拿得到）。 */
function viewPluginBridge(): Extension {
  return ViewPlugin.fromClass(
    class {
      private handler = (event: Event): void => {
        const detail = (event as CustomEvent<{ from: number; to: number; markdown: string }>).detail;
        this.view.dispatch({
          changes: { from: detail.from, to: detail.to, insert: detail.markdown },
        });
      };
      constructor(public view: EditorView) {
        window.addEventListener("kb:table-writeback", this.handler);
      }
      destroy(): void {
        window.removeEventListener("kb:table-writeback", this.handler);
      }
    },
  );
}
