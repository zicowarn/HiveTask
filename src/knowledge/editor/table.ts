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
import { serializeTable, parseTable as parseGrid, type TableModel } from "./markdown-table";
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
  /** 编辑会话：该表格正在被直接编辑（按起始行号识别；重算时沿用同一 widget，保住 DOM 与焦点）。 */
  static editing: { startLine: number; widget: TableWidget } | null = null;

  constructor(
    readonly source: string,
    private readonly options?: {
      /** 表格在文档中的范围（直接编辑写回用）。 */
      range?: { from: number; to: number };
      /** 表格起始行号（1 基）——编辑会话的身份标识。 */
      startLine?: number;
      /** 双击/按钮 → 打开网格编辑器（宿主注入；widget 不 import bus，避免循环依赖）。 */
      onEdit?: () => void;
    },
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
    const range = this.options?.range;
    const editable = Boolean(range);
    if (parsed && editable && range) {
      // ---- muya 思路：渲染态的单元格**直接可编辑**（contenteditable=plaintext-only）。
      // 输入实时写回源码（去抖 600ms）；blur 立即写回。Cell 内容按纯文本处理。
      wrap.classList.add("cm-kb-table--editable");
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      parsed.header.forEach((cellText, col) => {
        const th = document.createElement("th");
        th.appendChild(this.makeCell(col, -1, cellText, parsed.align[col], range));
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement("tbody");
      for (let r = 0; r < parsed.rows.length; r += 1) {
        const tr = document.createElement("tr");
        parsed.rows[r].forEach((cellText, col) => {
          const td = document.createElement("td");
          td.appendChild(this.makeCell(col, r, cellText, parsed.align[col], range));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
    } else {
      wrap.innerHTML = parsed ? renderTableHtml(parsed) : "";
    }

    // 悬停浮现的「编辑」按钮：双击/按钮 → 网格编辑器（结构性编辑：增删行列、对齐）。
    if (this.options?.onEdit) {
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
        this.options?.onEdit?.();
      });
      wrap.appendChild(btn);
    }
    // 注：不再绑 dblclick → 网格编辑器。单元格直接编辑后，双击落在单元格上
    // 会被系统当作两次选中/取词，且会在输入中途弹出对话框与写回竞态。
    // 结构性编辑走悬停铅笔（明确意图），内容编辑直接点单元格。
    return wrap;
  }

  /** 一个可编辑单元格：focus 抢占编辑会话；input 去抖写回；blur 立即写回。 */
  private makeCell(
    _col: number,
    _row: number,
    text: string,
    align: Align,
    range: { from: number; to: number },
  ): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "cm-kb-cell";
    cell.contentEditable = "plaintext-only";
    cell.style.textAlign = align ?? "left";
    cell.textContent = text;
    // ⚠️ 必须 preventDefault + 捕获：CM6 在自己的 mousedown 处理里会把光标挪进表格范围，
    // 触发装饰重算 → 塌回源码（用户实测"点一下就进源码"）。阻止默认定位，焦点交给
    // contenteditable 单元格自己。
    cell.addEventListener(
      "mousedown",
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        // CM6 的 mousedown handler 会在编辑器无焦点时 blur 掉 activeElement 并
        // 抢焦点到 contentDOM（focusPreventScroll + active.blur）——把焦点再抢回来。
        // 同时声明编辑会话：装饰重算时沿用同一 widget，DOM 与焦点才不会被重建冲掉。
        TableWidget.editing = { startLine: this.options?.startLine ?? -1, widget: this };
        setTimeout(() => {
          cell.focus();
          cell.classList.add("cm-kb-cell--focus");
        }, 0);
      },
      { capture: true },
    );
    let timer: number | null = null;
    const flush = (): void => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      this.writeBack(range, cell);
    };
    cell.addEventListener("input", () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(flush, 600);
    });
    cell.addEventListener("blur", () => {
      cell.classList.remove("cm-kb-cell--focus");
      TableWidget.editing = null;
      flush();
    });
    // Enter 换行会劈碎表格行——吞掉（Shift+Enter 也吞；要换行用 <br> 的场景去源码模式）
    cell.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        (ev.target as HTMLElement).blur();
      }
    });
    return cell;
  }

  /** 把当前渲染表格的每格内容重建成 Markdown，写回文档中的表格范围。 */
  private writeBack(range: { from: number; to: number }, edited: HTMLElement): void {
    const tableEl = edited.closest("table");
    if (!tableEl) return;
    const readRow = (tr: HTMLTableRowElement): string[] =>
      Array.from(tr.querySelectorAll(".cm-kb-cell")).map((cell) =>
        (cell.textContent ?? "").replace(/\n/g, " ").trim(),
      );
    const headRow = tableEl.querySelector<HTMLTableRowElement>("thead tr");
    if (!headRow) return;
    const header = readRow(headRow);
    const rows = Array.from(tableEl.querySelectorAll("tbody tr")).map((tr) => readRow(tr as HTMLTableRowElement));
    const parsed = parseGrid(this.source);
    const model: TableModel = { header, aligns: parsed?.aligns ?? [], rows };
    const markdown = serializeTable(model);
    window.dispatchEvent(
      new CustomEvent("kb:table-writeback", { detail: { ...range, markdown } }),
    );
  }

  ignoreEvent(): boolean {
    // 可编辑模式下必须放行事件（contenteditable 单元格要接收点击/键盘）
    return !this.options?.range;
  }
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
      // 表格**永远保持渲染态**——单元格本身可编辑（muya 口径），不存在"塌回源码"
      // 这个中间态。源码编辑走源码模式（livePreview 关）或网格对话框（铅笔）。
      // （旧规则"光标进范围即撤销 widget"已删：它是"点两下变源码"的直接根源。）
      const source = state.doc.sliceString(node.from, node.to);
      // 装饰重算会新建 widget → DOM 重建 → 编辑中的焦点/类丢失。编辑会话期间
      // **沿用同一个 widget 实例**，让 CM6 按 eq() 判定 DOM 可复用。
      if (!parseTable(source)) return;
      // 装饰重算会新建 widget → DOM 重建 → 编辑中的焦点/类丢失。编辑会话期间
      // **沿用同一个 widget 实例**，让 CM6 按 eq() 判定 DOM 可复用。
      const first = state.doc.lineAt(node.from);
      const last = state.doc.lineAt(node.to);
      if (TableWidget.editing && TableWidget.editing.startLine === first.number) {
        const live = TableWidget.editing.widget;
        if (live.source === source) {
          items.push({
            from: first.from,
            to: last.to,
            deco: Decoration.replace({ block: true, widget: live }),
          });
          return;
        }
        TableWidget.editing = null; // 内容变了（如写回后的新状态），让新 widget 接管
      }
      items.push({
        from: first.from,
        to: last.to,
        deco: Decoration.replace({
          block: true,
          widget: new TableWidget(source, {
            range: { from: first.from, to: last.to },
            startLine: first.number,
            onEdit,
          }),
        }),
      });
    },
  });
  return items;
}

export const tableTheme = EditorView.baseTheme({
  ".cm-kb-table": { display: "block", padding: "26px 0 6px", overflowX: "auto", position: "relative" },
  ".cm-kb-table table": { borderCollapse: "collapse", width: "100%", fontSize: "var(--font-base)" },
  ".cm-kb-table th, .cm-kb-table td": {
    border: "1px solid var(--border)",
    padding: "0",
    textAlign: "left",
    verticalAlign: "top",
  },
  ".cm-kb-table th": { backgroundColor: "var(--bg-app)", fontWeight: "600" },
  // 可编辑单元格：聚焦 = 1px 内描边 + 极淡强调底（与网格对话框 .tbl__focus 同一口径）；
  // 去掉浏览器默认的系统蓝 outline（用户截图里那个粗框）
  ".cm-kb-cell": {
    outline: "none",
    padding: "5px 10px",
    minHeight: "1em",
    height: "100%",
    boxSizing: "border-box",
  },
  ".cm-kb-cell.cm-kb-cell--focus": {
    boxShadow: "inset 0 0 0 1px var(--accent)",
    backgroundColor: "var(--accent-soft)",
  },
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
    /* icon 在 wrap 的顶部 padding 带内：底边贴 <table> 顶边、右缘与 <table> 右缘对齐。
       （不用 translateY(-100%)——那会把按钮推出 wrap，被上一行内容遮盖/裁剪。） */
    top: "4px",
    right: "0",
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
