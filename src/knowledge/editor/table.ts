/**
 * 表格 widget：光标不在表内时，把 GFM 表格渲染成真正的 `<table>`。
 *
 * 与其它块级渲染同一口径（光标进入即回到源码可编辑）。
 * 单元格内容走 markdown-it 的 **inline** 渲染（粗体/行内代码/链接可用），
 * 配置与 `MarkdownView` 相同：`html:false` + `linkify`，渲染结果可安全用于 innerHTML。
 *
 * HiveTask 注：解析与渲染拆成纯函数（`parseTable` / `renderTableHtml`），
 * 以便在无 DOM 的测试环境里覆盖（widget 的 `toDOM` 只负责贴 HTML）。
 * 前身参照 SoloMD 的 `cm-live-blocks.ts` 表格段（MIT，© 2026 xiangdong li），
 * 我们改为「解析 + markdown-it inline」而非直接透传源码。
 */
import { fullSyntaxTree } from "./tree";
import type { SyntaxNodeRef } from "@lezer/common";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import MarkdownIt from "markdown-it";
import type { RenderItem } from "./live-render";

const md = new MarkdownIt({ html: false, linkify: true });

export type Align = "left" | "center" | "right" | null;

export interface ParsedTable {
  header: string[];
  align: Align[];
  rows: string[][];
}

/** 按未转义的 `|` 切分表格行（`\|` 视为字面竖线）。 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/** 分隔行（`|:---|---:|`）→ 各列对齐方式。 */
function parseAlign(line: string): Align[] {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

function isDelimiterRow(line: string): boolean {
  return /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line) && line.includes("-");
}

/** 表格源码 → 结构（首行为表头，第二行为分隔行）。 */
export function parseTable(source: string): ParsedTable | null {
  const lines = source.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2 || !isDelimiterRow(lines[1])) return null;
  const header = splitRow(lines[0]);
  const align = parseAlign(lines[1]);
  const rows = lines.slice(2).map(splitRow);
  const width = header.length;
  // 补齐/裁剪到表头列数，避免参差行把表撑歪
  const normalize = (cells: string[]) =>
    Array.from({ length: width }, (_, i) => cells[i] ?? "");
  return { header, align, rows: rows.map(normalize) };
}

/** 结构 → HTML（单元格内容走 markdown-it inline）。 */
export function renderTableHtml(table: ParsedTable): string {
  const alignAttr = (i: number) => (table.align[i] ? ` style="text-align:${table.align[i]}"` : "");
  const head = table.header
    .map((cell, i) => `<th${alignAttr(i)}>${md.renderInline(cell)}</th>`)
    .join("");
  const body = table.rows
    .map(
      (row) =>
        `<tr>${row.map((cell, i) => `<td${alignAttr(i)}>${md.renderInline(cell)}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-kb-table";
    const parsed = parseTable(this.source);
    wrap.innerHTML = parsed ? renderTableHtml(parsed) : "";
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function cursorTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/**
 * 表格是**跨行**替换：按 CM6 规则必须用 `block: true` 且覆盖整行，
 * 并且只能由 state facet（`EditorView.decorations`）提供——ViewPlugin 提供会抛
 * `Decorations that replace line breaks may not be specified via plugins`。
 */
export function tableItems(state: EditorState): RenderItem[] {
  const items: RenderItem[] = [];
  fullSyntaxTree(state).iterate({
    enter: (node: SyntaxNodeRef) => {
      if (node.name !== "Table") return;
      if (cursorTouches(state, node.from, node.to)) return;
      const source = state.doc.sliceString(node.from, node.to);
      if (!parseTable(source)) return;
      const first = state.doc.lineAt(node.from);
      const last = state.doc.lineAt(node.to);
      items.push({
        from: first.from,
        to: last.to,
        deco: Decoration.replace({ block: true, widget: new TableWidget(source) }),
      });
    },
  });
  return items;
}

export const tableTheme = EditorView.baseTheme({
  ".cm-kb-table": { display: "block", padding: "6px 0", overflowX: "auto" },
  ".cm-kb-table table": { borderCollapse: "collapse", width: "100%", fontSize: "var(--font-base)" },
  ".cm-kb-table th, .cm-kb-table td": {
    border: "1px solid var(--border)",
    padding: "5px 10px",
    textAlign: "left",
    verticalAlign: "top",
  },
  ".cm-kb-table th": { backgroundColor: "var(--bg-app)", fontWeight: "600" },
  ".cm-kb-table code": {
    fontFamily: "var(--kb-mono)",
    fontSize: "0.92em",
    backgroundColor: "var(--bg-app)",
    padding: "1px 4px",
    borderRadius: "3px",
  },
  ".cm-kb-table a": { color: "var(--accent)" },
});
