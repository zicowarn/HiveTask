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
import { t } from "../../i18n";

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
  constructor(
    readonly source: string,
    /** 双击/按钮 → 打开网格编辑器（由宿主注入；widget 不 import bus，避免循环依赖）。 */
    private readonly onEdit?: () => void,
  ) {
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
    // 悬停浮现的「编辑」按钮：渲染态直达网格编辑器（不必先点进源码再按 ⌥⌘T）。
    // mousedown preventDefault：阻止 CM6 把这次点击当光标操作。
    if (this.onEdit) {
      const btn = document.createElement("button");
      btn.className = "cm-kb-table-edit";
      btn.type = "button";
      btn.title = t("tableEditor.heading");
      btn.setAttribute("aria-label", t("tableEditor.heading"));
      btn.innerHTML =
        '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.25.25 0 0 1-.304-.304l.92-3.25a1.873 1.873 0 0 1 .446-.759Zm.85 1.507a.25.25 0 0 0-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354Zm-1.698 2.265L3.725 10.13a.376.376 0 0 0-.09.187l-.38 1.927 1.927-.38c.07-.015.136-.046.187-.09Z"/></svg>';
      btn.addEventListener("mousedown", (ev) => ev.preventDefault());
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.onEdit?.();
      });
      wrap.appendChild(btn);
    }
    // 双击表格主体 = 同样直达编辑器（发现的自然性：双击是"编辑"的通用直觉）
    wrap.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.onEdit?.();
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return true; // 单击不进光标（保持"渲染态整块"）；编辑走按钮/双击
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
export function tableItems(state: EditorState, onEdit?: () => void): RenderItem[] {
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
        deco: Decoration.replace({ block: true, widget: new TableWidget(source, onEdit) }),
      });
    },
  });
  return items;
}

export const tableTheme = EditorView.baseTheme({
  ".cm-kb-table": { display: "block", padding: "6px 0", overflowX: "auto", position: "relative" },
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
  // 悬停浮现的「编辑」按钮：右上角小铅笔
  ".cm-kb-table-edit": {
    position: "absolute",
    top: "4px",
    right: "4px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "22px",
    height: "22px",
    border: "1px solid var(--border)",
    borderRadius: "5px",
    background: "var(--bg-panel)",
    color: "var(--text-dim)",
    cursor: "pointer",
    opacity: "0",
    transition: "opacity 0.12s",
  },
  ".cm-kb-table:hover .cm-kb-table-edit": { opacity: "1" },
  ".cm-kb-table-edit:hover": { color: "var(--accent)", borderColor: "var(--accent)" },
});
