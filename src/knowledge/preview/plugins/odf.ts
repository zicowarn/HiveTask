/**
 * ODF 文档预览（`odt`/`ott` 文本文档、`odp`/`otp` 演示文稿）—— **自研解析**。
 *
 * ODF 与 OOXML 一样是 zip + XML，但**结构完全不同**：正文在 `content.xml` 的
 * `office:body` → `office:text`（文本文档）或 `office:presentation`（演示文稿）里，
 * 元素是 `text:h`（带 `text:outline-level` 的标题）、`text:p`、`table:table`。
 * 所以不能交给 docx-preview（它只认 OOXML）—— 这也解释了为什么 `.odt` 以前会被
 * 当成普通压缩包列目录（当时没有任何插件认领它）。
 *
 * 范围（如实标注）：
 * - 文本段落与**标题层级**（顺带产出大纲）、表格（按行列还原）；
 * - 列表逐项渲染（`text:list-item`），不还原编号样式；
 * - 图片、图形、页眉页脚、样式（粗斜体/字号/颜色）不还原 —— 预览层只求"内容可读 + 结构可导航"。
 */
import type { PreviewContext, PreviewInstance, PreviewTool } from "../registry";
import { withFind } from "../dom-find";
import { trackPages } from "../paging";

export const ODF_TEXT_EXTENSIONS = ["odt", "ott", "fodt"];
export const ODF_SLIDES_EXTENSIONS = ["odp", "otp", "fodp"];

/** 按**本地名**取所有后代（ODF 各家前缀不统一，与 OFD 同一套写法）。 */
function byLocalName(root: Document | Element, local: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", local));
}

function firstByLocalName(root: Document | Element, local: string): Element | undefined {
  return byLocalName(root, local)[0];
}

interface OdfBlock {
  kind: "heading" | "paragraph" | "list" | "table";
  level?: number;
  text?: string;
  /** 列表项 / 表格行。 */
  items?: string[][];
}

/** `content.xml` → 结构块序列（纯函数，便于单测）。 */
export function parseOdfBody(xml: string): OdfBlock[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const body = firstByLocalName(doc, "body");
  if (!body) return [];
  // 文本文档在 office:text 下，演示文稿在 office:presentation 下
  const root = firstByLocalName(body, "text") ?? firstByLocalName(body, "presentation") ?? body;
  const blocks: OdfBlock[] = [];

  const walk = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      switch (child.localName) {
        case "h": {
          const level = Number(child.getAttribute("text:outline-level") ?? child.getAttributeNS("*", "outline-level") ?? "1") || 1;
          blocks.push({ kind: "heading", level, text: textOf(child) });
          break;
        }
        case "p": {
          const text = textOf(child);
          if (text.trim()) blocks.push({ kind: "paragraph", text });
          break;
        }
        case "list": {
          const items = byLocalName(child, "list-item").map((item) => [textOf(item)]);
          if (items.length) blocks.push({ kind: "list", items });
          break;
        }
        case "table": {
          const rows = byLocalName(child, "table-row").map((row) =>
            byLocalName(row, "table-cell").map((cell) => textOf(cell)),
          );
          if (rows.length) blocks.push({ kind: "table", items: rows });
          break;
        }
        case "page":
        case "draw-page":
          // 演示文稿：每页抽文本（首位当标题）
          blocks.push({ kind: "paragraph", text: textOf(child) || "（空白页）" });
          break;
        default:
          // 其它容器（如 text:section）继续往里走
          if (child.children.length) walk(child);
      }
    }
  };
  walk(root);
  return blocks;
}

/**
 * 元素文本：`text:p` 没在段落边界加换行的话，多段会粘成一行 —— 所以在段落级元素处补 `\n`。
 *
 * ⚠️ 不能用 `textContent`：它会跨段拼接、也会丢掉段落分隔（实测"正文一段正文二段"粘一起）。
 */
function textOf(node: Element): string {
  let out = "";
  const walk = (current: Node): void => {
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent ?? "";
        continue;
      }
      const el = child as Element;
      if (el.localName === "s") {
        out += " ".repeat(Number(el.getAttribute("text:c") ?? el.getAttributeNS("*", "c") ?? "1") || 1);
        continue;
      }
      if (el.localName === "line-break") {
        out += "\n";
        continue;
      }
      walk(el);
      if (el.localName === "p" || el.localName === "h") out += "\n";
    }
  };
  walk(node);
  return out.replace(/\n+$/, "");
}

export const odfTextPlugin = {
  id: "odfText",
  tools: ["find", "outline"] satisfies PreviewTool[],
  extensions: ODF_TEXT_EXTENSIONS,
  async render(ctx: PreviewContext): Promise<PreviewInstance> {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await ctx.readBytes());
    const content = zip.file("content.xml");
    if (!content) throw new Error("不是有效的 ODF 文档（缺少 content.xml）");
    const blocks = parseOdfBody(await content.async("string"));

    const wrap = document.createElement("div");
    wrap.className = "kb-odf markdown-body";
    const outline: { level: number; title: string; target: number }[] = [];
    let elementIndex = 0;
    const elements: HTMLElement[] = [];

    const push = (el: HTMLElement): void => {
      wrap.appendChild(el);
      elements.push(el);
      elementIndex += 1;
    };

    for (const block of blocks) {
      if (block.kind === "heading") {
        const level = Math.min(Math.max(block.level ?? 1, 1), 6);
        const el = document.createElement(`h${level}`);
        el.textContent = block.text ?? "";
        // 大纲条目指向"第几个块"，reveal 时按这个下标滚（文档顺序天然稳定）
        outline.push({ level, title: block.text ?? "", target: elementIndex + 1 });
        push(el);
        continue;
      }
      if (block.kind === "paragraph") {
        const el = document.createElement("p");
        el.textContent = block.text ?? "";
        push(el);
        continue;
      }
      if (block.kind === "list") {
        const list = document.createElement("ul");
        for (const item of block.items ?? []) {
          const li = document.createElement("li");
          li.textContent = item[0] ?? "";
          list.appendChild(li);
        }
        push(list);
        continue;
      }
      const table = document.createElement("table");
      table.className = "kb-odf-table";
      for (const [rowIndex, row] of (block.items ?? []).entries()) {
        const tr = document.createElement("tr");
        for (const cell of row) {
          const td = document.createElement(rowIndex === 0 ? "th" : "td");
          td.textContent = cell;
          tr.appendChild(td);
        }
        table.appendChild(tr);
      }
      push(table);
    }

    if (!blocks.length) {
      const note = document.createElement("p");
      note.className = "kb-note";
      note.textContent = "这份 ODF 文档没有可显示的正文（可能是纯图形的版式文档）。";
      wrap.appendChild(note);
    }

    ctx.container.replaceChildren(wrap);
    return withFind(ctx, {
      outline,
      reveal: (target) => {
        const el = elements[target - 1];
        if (!el) return;
        const top = el.getBoundingClientRect().top - ctx.container.getBoundingClientRect().top;
        ctx.container.scrollTo?.({ top: ctx.container.scrollTop + top - 12, behavior: "smooth" });
      },
    });
  },
};

/** 演示文稿（odp）：每页一个块，页码可跳（与 pptx 同一套口径）。 */
export const odfSlidesPlugin = {
  id: "odfSlides",
  tools: ["find", "outline"] satisfies PreviewTool[],
  extensions: ODF_SLIDES_EXTENSIONS,
  async render(ctx: PreviewContext): Promise<PreviewInstance> {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await ctx.readBytes());
    const content = zip.file("content.xml");
    if (!content) throw new Error("不是有效的 ODF 演示文稿（缺少 content.xml）");
    const doc = new DOMParser().parseFromString(await content.async("string"), "application/xml");
    const pages = byLocalName(doc, "page");

    const wrap = document.createElement("div");
    wrap.className = "kb-slides";
    const note = document.createElement("p");
    note.className = "kb-note";
    note.textContent = `共 ${pages.length} 页（本期为文本视图，版面渲染待接入渲染器）`;
    wrap.appendChild(note);

    const titles: string[] = [];
    for (const [index, page] of pages.entries()) {
      const texts = byLocalName(page, "p")
        .map((p) => textOf(p).trim())
        .filter(Boolean);
      titles.push(texts[0] ?? `第 ${index + 1} 页`);
      const section = document.createElement("section");
      section.className = "kb-slide";
      const title = document.createElement("h3");
      title.textContent = `第 ${index + 1} 页`;
      const list = document.createElement("ul");
      for (const text of texts) {
        const item = document.createElement("li");
        item.textContent = text;
        list.appendChild(item);
      }
      section.append(title, list);
      wrap.appendChild(section);
    }

    ctx.container.replaceChildren(wrap);
    const pager = trackPages({
      scroller: ctx.container,
      pages: () => Array.from(wrap.querySelectorAll<HTMLElement>(".kb-slide")),
      report: (state) => ctx.onPaging?.(state),
    });
    pager.refresh();
    return withFind(ctx, {
      outline: titles.map((title, index) => ({ level: 1, title, target: index + 1 })),
      reveal: (page) => pager.reveal(page),
      destroy: () => pager.destroy(),
    });
  },
};
