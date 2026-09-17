/**
 * Office 系预览：docx / xlsx / xls / csv 与 pptx。
 *
 * 与 OFV 的 office 插件同思路（它 9566 行，大头是 docx 文本框版面回退），我们做**可达的等价**：
 * - **docx** → `docx-preview` 渲染（保真度最好）；**渲染结果异常空白**时用 `mammoth` 走内容回退
 *   （OFV 也这么兜底：docx-preview 对"文本框里套正文"的排版常吐空白页）；
 * - **xlsx / xls / csv** → SheetJS 解析，**多工作表页签 + 表格**（`xls` 是 BIFF8 老格式，SheetJS 能读）；
 * - **pptx** → 暂以"页数与文本抽取"呈现（完整版面渲染需要 pptx 渲染器，见文件末尾说明）。
 *
 * 全部本地解析，无任何远程服务。
 */
import type { PreviewContext, PreviewInstance, PreviewTool, ZoomAction } from "../registry";
import { withFind } from "../dom-find";
import { scrollToElement, trackPages } from "../paging";
import { ZoomController, type FitMode } from "../zoom";

/**
 * 扩展名清单**按各库的真实能力**列，不按"听起来该支持"列：
 * - Word：docx-preview / mammoth 都只吃 **OOXML**（docx 家族）。ODT/FODT 是 OASIS 的
 *   另一套容器，这两个库都读不了 —— 收进来只会"能打开却报错"，所以不收（见格式清单 §5）；
 * - 表格：SheetJS 能吃 OOXML + BIFF + **ODF 表格**（ods/fods）+ csv/tsv ✓；
 * - 演示：本插件是自己解 zip 取 ppt/slides XML，OOXML 家族都成立；ODP 是 ODF，不收。
 */
export const WORD_EXTENSIONS = ["docx", "docm", "dotx", "dotm"];
export const SHEET_EXTENSIONS = ["xlsx", "xlsm", "xlsb", "xls", "csv", "tsv", "ods", "fods"];
export const SLIDES_EXTENSIONS = ["pptx", "pptm", "ppsx", "potx"];

const OOXML_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // docx/xlsx/pptx 都是 zip
const BIFF_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // 旧版 .doc/.xls/.ppt（OLE2 复合文档）

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}

/** zip 内首个条目的名字（用来区分 docx / xlsx / pptx —— 它们都是 zip）。 */
async function firstZipEntryName(bytes: Uint8Array): Promise<string | null> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  return Object.keys(zip.files)[0] ?? null;
}

/**
 * docx 的缩放：用 CSS `zoom` 做**布局比例缩放**。
 *
 * 为什么不能像 SVG 那样"改 width 重排"：docx 是版式文档，断行位置是排版时算好的 ——
 * 改宽度会让正文重新折行，版面就不是原件的样子了。`zoom` 缩放的是布局比例，内部比例不变，
 * 断行不动。WebKit 长期支持它（我们的运行时就是 WebKit）；万一不支持，该属性被忽略，
 * 预览退回 100%，不会坏。
 */
interface DocxZoom {
  destroy: () => void;
  zoom: (action: ZoomAction) => void;
}

function docxZoom(ctx: PreviewContext, host: HTMLElement): DocxZoom {
  const controller = new ZoomController({
    // docx-preview 把每页渲染成固定宽度的块：以第一页宽度为"内容宽度"
    content: () => {
      const page = host.querySelector<HTMLElement>(".docx-wrapper > .docx, .docx");
      const width = page?.offsetWidth || page?.scrollWidth || 0;
      const height = page?.offsetHeight || page?.scrollHeight || 0;
      return { width, height };
    },
    viewport: () => {
      const rect = ctx.container.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    },
    anchor: "width",
    apply: (scale) => {
      host.style.zoom = String(scale);
    },
    report: (state) => ctx.onZoom?.(state),
  });
  controller.fit();
  const observer = new ResizeObserver(() => controller.refit());
  observer.observe(ctx.container);
  return {
    destroy: () => observer.disconnect(),
    zoom(action) {
      if (action === "fit") controller.fit();
      else if (action === "fit-width") controller.fit("width");
      else if (action === "fit-page") controller.fit("page");
      else controller.step(action);
    },
  };
}

export interface DocxHeading {
  level: number;
  title: string;
}

/**
 * 从 `word/document.xml` 抽标题（大纲）。
 *
 * 关键：**不能只认 `w:pStyle w:val="Heading1"`**。真实方案书里 styleId 是数字
 * （`w:pStyle w:val="2"`），级别写在 `word/styles.xml` 的样式名/`w:outlineLvl` 里。
 * 所以先把 styles.xml 读成 `styleId → 级别`，再按段落查；段落自带的 `w:outlineLvl` 也认。
 */
export function parseDocxHeadings(documentXml: string, stylesXml: string): DocxHeading[] {
  const levelByStyle = new Map<string, number>();
  if (stylesXml) {
    const styles = new DOMParser().parseFromString(stylesXml, "application/xml");
    for (const style of Array.from(styles.getElementsByTagNameNS("*", "style"))) {
      const id = style.getAttribute("w:styleId") ?? style.getAttribute("styleId");
      if (!id) continue;
      const name = style.getElementsByTagNameNS("*", "name")[0]?.getAttribute("w:val") ?? "";
      const byName = /^(?:heading|标题)\s*([1-9])/i.exec(name);
      if (byName) {
        levelByStyle.set(id, Number(byName[1]));
        continue;
      }
      const outline = style.getElementsByTagNameNS("*", "outlineLvl")[0]?.getAttribute("w:val");
      if (outline !== null && outline !== undefined) levelByStyle.set(id, Number(outline) + 1);
    }
  }

  const doc = new DOMParser().parseFromString(documentXml, "application/xml");
  const headings: DocxHeading[] = [];
  for (const paragraph of Array.from(doc.getElementsByTagNameNS("*", "p"))) {
    if (paragraph.getElementsByTagNameNS("*", "pPr").length === 0 && paragraph.parentElement?.localName === "pPr") continue;
    const pPr = Array.from(paragraph.children).find((child) => child.localName === "pPr");
    const styleId = pPr?.getElementsByTagNameNS("*", "pStyle")[0]?.getAttribute("w:val") ?? "";
    let level = levelByStyle.get(styleId) ?? 0;
    if (!level) {
      const own = pPr?.getElementsByTagNameNS("*", "outlineLvl")[0]?.getAttribute("w:val");
      if (own !== null && own !== undefined) level = Number(own) + 1;
    }
    if (!level) continue;
    // 只取正文文本（`w:instrText`/`w:delText` 是域代码与修订删除的内容，不算标题）
    const text = Array.from(paragraph.getElementsByTagNameNS("*", "t"))
      .filter((node) => node.parentElement?.localName === "r")
      .map((node) => node.textContent ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (text) headings.push({ level, title: text });
  }
  return headings;
}

/**
 * 把标题按**文档顺序**映射回渲染出来的 DOM 块（按文本比对，指针只前进）。
 * 相同文本的重复标题靠"指针不回退"区分，不会全部指到第一个。
 */
export function mapHeadingsToDom(host: HTMLElement, headings: DocxHeading[]): HTMLElement[] {
  const blocks = Array.from(host.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6"));
  const elements: HTMLElement[] = [];
  let cursor = 0;
  for (const heading of headings) {
    const needle = heading.title;
    let found: HTMLElement | null = null;
    for (let i = cursor; i < blocks.length; i += 1) {
      if ((blocks[i].textContent ?? "").replace(/\s+/g, " ").trim() === needle) {
        found = blocks[i];
        cursor = i + 1;
        break;
      }
    }
    if (found) elements.push(found);
  }
  return elements;
}

/** 按"版心高度"折算的页码（纯函数，便于单测）。 */
export function pageAt(contentHeight: number, pageHeight: number, scrolled: number): { page: number; total: number } {
  if (pageHeight <= 0 || contentHeight <= 0) return { page: 1, total: 1 };
  const total = Math.max(1, Math.ceil(contentHeight / pageHeight));
  const page = Math.min(total, Math.max(1, Math.floor(Math.max(0, scrolled) / pageHeight) + 1));
  return { page, total };
}

/**
 * docx 的"当前位置"与跳转。
 *
 * **页码是按版心高度折算的**：docx-preview 只会在显式分页符处切页，Word 的真实分页
 * （孤行控制、段中不分页…）它复现不了。所以这里的页 = "内容高度 ÷ 一页纸高度"，
 * 与你滚动到哪儿一一对应（自洽），但与 Word 打印页码可能有 ±1 的出入。
 * 这一点写在交付说明与格式文档里，不藏着；同时用**当前章节**（来自大纲）兜住"我在哪"。
 */
interface DocxPaging {
  destroy: () => void;
  reveal: (index: number) => void;
  refresh: () => void;
}

function docxPaging(ctx: PreviewContext, host: HTMLElement, headingEls: HTMLElement[]): DocxPaging {
  const container = ctx.container;

  const measure = (): { page: number; total: number } => {
    const pageEl = host.querySelector<HTMLElement>(".docx");
    if (!pageEl) return { page: 1, total: 1 };
    const zoom = Number.parseFloat(host.style.zoom || "1") || 1;
    const minHeight = Number.parseFloat(getComputedStyle(pageEl).minHeight || "0");
    const pageHeight = (minHeight > 0 ? minHeight : pageEl.getBoundingClientRect().height / zoom) * zoom;
    const containerRect = container.getBoundingClientRect();
    const firstRect = pageEl.getBoundingClientRect();
    const contentTop = firstRect.top - containerRect.top + container.scrollTop;
    const contentHeight = pageEl.scrollHeight * zoom || firstRect.height;
    return pageAt(contentHeight, pageHeight, container.scrollTop - contentTop);
  };

  const report = (): void => {
    const state = measure();
    ctx.onPaging?.(state);
    // 当前章节：最后一个"顶部已越过视口顶部"的标题
    if (headingEls.length) {
      const containerTop = container.getBoundingClientRect().top;
      let active: string | null = null;
      for (const el of headingEls) {
        if (el.getBoundingClientRect().top - containerTop <= 24) active = el.textContent?.trim() ?? active;
        else break;
      }
      ctx.onSection?.(active);
    }
  };

  let scheduled = false;
  const onScroll = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      report();
    });
  };
  container.addEventListener("scroll", onScroll, { passive: true });
  report();

  return {
    destroy: () => container.removeEventListener("scroll", onScroll),
    /** 跳到大纲第 index 条（1 基）：滚到该标题，并立刻重报位置。 */
    reveal: (index: number) => {
      const el = headingEls[index - 1];
      if (!el) return;
      scrollToElement(container, el);
      report();
    },
    /** 缩放/重排后重算（页码按版心高度折算，量完才准）。 */
    refresh: report,
  };
}

/** docx：先 docx-preview，空白则 mammoth 内容回退。 */
async function renderWord(ctx: PreviewContext): Promise<PreviewInstance> {
  const docx = await import("docx-preview");
  const bytes = await ctx.readBytes();
  const host = document.createElement("div");
  host.className = "kb-docx";
  ctx.container.replaceChildren(host);
  try {
    await docx.renderAsync(bytes.buffer as ArrayBuffer, host, undefined, {
      className: "docx",
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
    });
  } catch {
    // 交给下面的空白检测统一处理
  }
  const text = host.textContent?.trim() ?? "";
  if (text.length > 0 && host.querySelector(".docx-wrapper, .docx") !== null) {
    // 大纲：从 document.xml + styles.xml 抽标题，再按文本顺序映射回渲染出来的段落
    const JSZip = (await import("jszip")).default;
    let headings: DocxHeading[] = [];
    try {
      const zip = await JSZip.loadAsync(bytes);
      const documentXml = await zip.file("word/document.xml")?.async("string");
      const stylesXml = await zip.file("word/styles.xml")?.async("string");
      headings = documentXml ? parseDocxHeadings(documentXml, stylesXml ?? "") : [];
    } catch {
      headings = []; // 大纲是加分项，抽不出来不影响正文
    }
    const headingEls = mapHeadingsToDom(host, headings);
    const paging = docxPaging(ctx, host, headingEls);
    const zoom = docxZoom(ctx, host);
    return withFind(ctx, {
      outline: headings.map((heading, index) => ({ level: heading.level, title: heading.title, target: index + 1 })),
      reveal: (target) => paging.reveal(target),
      zoom: (action) => {
        zoom.zoom(action);
        paging.refresh(); // 缩放改变版心折算，页码要重报
      },
      destroy: () => {
        paging.destroy();
        zoom.destroy();
      },
    });
  }
  // 回退：mammoth 抽 HTML（会丢版面，但至少有内容）。
  // 这条路径**必须自己兜住异常**：docx-preview 失败 + mammoth 也失败时，
  // 异常若逃出去就是一条 unhandled rejection（实测在测试环境里炸过），
  // 而这里本该给一句"打不开 + 用默认应用打开"，不是把控制台刷红。
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer });
    const { default: DOMPurify } = await import("dompurify");
    const fallback = document.createElement("div");
    fallback.className = "kb-docx-fallback markdown-body";
    fallback.innerHTML = DOMPurify.sanitize(result.value, { USE_PROFILES: { html: true } });
    const note = document.createElement("p");
    note.className = "kb-note";
    note.textContent = result.messages.length > 0 ? result.messages.map((m) => m.message).join("；") : "";
    ctx.container.replaceChildren(fallback, note);
    return withFind(ctx);
  } catch (error) {
    const note = document.createElement("p");
    note.className = "kb-note";
    note.textContent = `这份 Word 文档解析失败（${String(error)}）。可以试试「默认应用打开」。`;
    ctx.container.replaceChildren(note);
    return {};
  }
}

/** 表格：多工作表页签 + 表格体。 */
async function renderSheet(ctx: PreviewContext): Promise<PreviewInstance> {
  const XLSX = await import("xlsx");
  const bytes = await ctx.readBytes();
  const workbook = XLSX.read(bytes, { type: "array" });
  const wrap = document.createElement("div");
  wrap.className = "kb-sheet";
  const tabs = document.createElement("div");
  tabs.className = "kb-sheet-tabs";
  const body = document.createElement("div");
  body.className = "kb-sheet-body";
  wrap.append(tabs, body);

  const renderSheetByName = (sheetName: string) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
    const table = document.createElement("table");
    table.className = "kb-sheet-table";
    for (const [index, row] of rows.entries()) {
      const tr = document.createElement("tr");
      for (const cell of row) {
        const td = document.createElement(index === 0 ? "th" : "td");
        td.textContent = cell === undefined || cell === null ? "" : String(cell);
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    body.replaceChildren(table);
    for (const button of tabs.querySelectorAll("button") as NodeListOf<HTMLButtonElement>) {
      button.classList.toggle("active", button.dataset.sheet === sheetName);
    }
  };

  for (const sheetName of workbook.SheetNames) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kb-sheet-tab";
    button.dataset.sheet = sheetName;
    button.textContent = sheetName;
    button.addEventListener("click", () => renderSheetByName(sheetName));
    tabs.appendChild(button);
  }
  if (workbook.SheetNames.length > 0) renderSheetByName(workbook.SheetNames[0]);

  ctx.container.replaceChildren(wrap);
  // 表格**不给大纲**（用户口径）：它的结构就是顶部那排工作表页签，放进大纲是重复。
  return withFind(ctx);
}

/**
 * pptx：**本期只做"可读"版本**——列出每页的文本（不上版面渲染）。
 * 完整的版式渲染需要 pptx 渲染器（OFV 用 @aiden0z/pptx-renderer）；留作后续增强，
 * 这里明确告知用户"这不是完整版面"，而不是假装渲染成功。
 */
async function renderSlides(ctx: PreviewContext): Promise<PreviewInstance> {
  const JSZip = (await import("jszip")).default;
  const bytes = await ctx.readBytes();
  const zip = await JSZip.loadAsync(bytes);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));

  const wrap = document.createElement("div");
  wrap.className = "kb-slides";
  const note = document.createElement("p");
  note.className = "kb-note";
  note.textContent = `共 ${slideNames.length} 页（本期为文本视图，版面渲染待接入渲染器）`;
  wrap.appendChild(note);

  /** 幻灯片标题：优先取标题占位符里的文本，回退取该页第一段文本（实测两版 Office 都能覆盖）。 */
  const slideTitles: string[] = [];
  for (const [index, name] of slideNames.entries()) {
    const xml = await zip.file(name)!.async("string");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const texts = Array.from(doc.getElementsByTagName("a:t"))
      .map((node) => node.textContent ?? "")
      .filter((text) => text.trim().length > 0);
    slideTitles.push(texts[0]?.trim() || `第 ${index + 1} 页`);
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
  // 「页」= 幻灯片：视图本来就是按张分块的，页码与跳转都可信
  const pager = trackPages({
    scroller: ctx.container,
    pages: () => Array.from(wrap.querySelectorAll<HTMLElement>(".kb-slide")),
    report: (state) => ctx.onPaging?.(state),
  });
  pager.refresh();
  return withFind(ctx, {
    // 大纲 = 幻灯片列表（「页」在这里就是「张」）；点它跳过去
    outline: slideTitles.map((title, index) => ({ level: 1, title, target: index + 1 })),
    reveal: (page) => pager.reveal(page),
    destroy: () => pager.destroy(),
  });
}

export const wordPlugin = {
  id: "word",
  extensions: WORD_EXTENSIONS,
  tools: ["zoom", "find", "outline"] satisfies PreviewTool[],
  // 文档类：基准 = 适应宽度（与 PDF 同一口径）
  zoomModes: ["width", "page"] satisfies FitMode[],
  matchHead: (head: Uint8Array) => startsWith(head, OOXML_MAGIC),
  render: renderWord,
};

export const sheetPlugin = {
  id: "sheet",
  extensions: SHEET_EXTENSIONS,
  tools: ["find"] satisfies PreviewTool[],
  // csv/tsv 是纯文本、xls 是 BIFF、xlsx 是 zip —— 所以这里只用于 magic 通道；
  // 扩展名通道一律认领（若对 csv 也要求 zip 头，真正的 csv 会被判成"不支持"）
  matchHead: (head: Uint8Array) => startsWith(head, OOXML_MAGIC) || startsWith(head, BIFF_MAGIC),
  render: renderSheet,
};

export const slidesPlugin = {
  id: "slides",
  extensions: SLIDES_EXTENSIONS,
  tools: ["find", "outline"] satisfies PreviewTool[],
  matchHead: (head: Uint8Array) => startsWith(head, OOXML_MAGIC),
  render: renderSlides,
};

/** 旧版 .doc/.ppt：OLE2 复合文档，浏览器侧没有可靠的纯 JS 解析器可移植 → 明确不支持。 */
export const LEGACY_OFFICE_EXTENSIONS = ["doc", "ppt", "rtf"];
export { firstZipEntryName };
