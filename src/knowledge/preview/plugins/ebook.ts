/**
 * 电子书与矢量文档预览：EPUB / XPS / XMind / drawio。
 *
 * - **EPUB**：zip + OPF 清单 → 按 spine 顺序把 XHTML 章节渲染进容器（HTML 经 DOMPurify 清洗），
 *   章节内图片从 zip 解出成 object URL；
 * - **XPS**：zip + 固定版式 XML（微软的 OFD 等价物）→ 列出页面与其中的 Glyphs 文本
 *   （完整版式渲染同样需要矢量引擎，如实标注）；
 * - **XMind**：zip + `content.json` → 用列表还原思维导图的层级（结构清晰优先于还原画布）；
 * - **drawio**：`mxGraphModel` XML → 顶点框 + 标签的示意图（不做连线正交路由）。
 */
import type { PreviewContext, PreviewInstance, PreviewTool } from "../registry";
import { withFind } from "../dom-find";
import { trackPages } from "../paging";

export const EPUB_EXTENSIONS = ["epub"];
export const XPS_EXTENSIONS = ["xps", "oxps"];
export const XMIND_EXTENSIONS = ["xmind"];
export const DRAWIO_EXTENSIONS = ["drawio", "dio"];

const OPC_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((value, index) => value === bytes[index]);
}

function note(text: string, className = "kb-note"): HTMLElement {
  const p = document.createElement("p");
  p.className = className;
  p.textContent = text;
  return p;
}

/** EPUB：按 spine 顺序渲染章节。 */
async function renderEpub(ctx: PreviewContext): Promise<PreviewInstance> {
  const JSZip = (await import("jszip")).default;
  const { default: DOMPurify } = await import("dompurify");
  const zip = await JSZip.loadAsync(await ctx.readBytes());

  const containerPath = zip.file("META-INF/container.xml");
  if (!containerPath) throw new Error("不是有效的 EPUB（缺少 META-INF/container.xml）");
  const containerDoc = new DOMParser().parseFromString(await containerPath.async("string"), "application/xml");
  const opfPath = containerDoc.getElementsByTagName("rootfile")[0]?.getAttribute("full-path") ?? "";
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error("EPUB 的 OPF 清单缺失");
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const opf = new DOMParser().parseFromString(await opfFile.async("string"), "application/xml");

  const manifest = new Map<string, string>();
  for (const item of Array.from(opf.getElementsByTagName("item"))) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest.set(id, href);
  }
  const spine = Array.from(opf.getElementsByTagName("itemref"))
    .map((ref) => manifest.get(ref.getAttribute("idref") ?? ""))
    .filter((href): href is string => !!href);

  const wrap = document.createElement("div");
  wrap.className = "kb-epub";
  const urls: string[] = [];

  for (const href of spine) {
    const path = `${opfDir}${href}`.replace(/\/{2,}/g, "/");
    const file = zip.file(path) ?? zip.file(decodeURIComponent(path));
    if (!file) continue;
    const html = await file.async("string");
    const chapter = document.createElement("section");
    chapter.className = "kb-epub-chapter markdown-body";
    // 章节内图片：把 src 换成 zip 内解出的 object URL（离线）
    const sanitized = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    chapter.innerHTML = sanitized;
    for (const img of Array.from(chapter.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      const imagePath = `${opfDir}${decodeURIComponent(src)}`.replace(/\/{2,}/g, "/");
      const imageFile = zip.file(imagePath);
      if (!imageFile) continue;
      const url = URL.createObjectURL(await imageFile.async("blob"));
      urls.push(url);
      img.src = url;
    }
    wrap.appendChild(chapter);
  }

  ctx.container.replaceChildren(wrap);
  return withFind(ctx, {
    destroy() {
      for (const url of urls) URL.revokeObjectURL(url);
    },
  });
}

/** XPS：固定版式页面 + 文本抽取。 */
async function renderXps(ctx: PreviewContext): Promise<PreviewInstance> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await ctx.readBytes());
  const pageNames = Object.keys(zip.files)
    .filter((name) => /Documents\/\d+\/Pages\/\d+\.fpage$/i.test(name))
    .sort();

  const wrap = document.createElement("div");
  wrap.className = "kb-xps";
  wrap.appendChild(note(`共 ${pageNames.length} 页（文本版式视图；XPS 的矢量绘制不在本期范围）`));
  for (const [index, name] of pageNames.entries()) {
    const xml = await zip.file(name)!.async("string");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const section = document.createElement("section");
    section.className = "kb-xps-page";
    const title = document.createElement("h3");
    title.textContent = `第 ${index + 1} 页`;
    section.appendChild(title);
    const texts = Array.from(doc.getElementsByTagNameNS("*", "Glyphs"))
      .map((node) => node.getAttribute("UnicodeString") ?? "")
      .filter((text) => text.trim());
    if (texts.length === 0) {
      section.appendChild(note("（本页没有可提取的文本）"));
    } else {
      const pre = document.createElement("pre");
      pre.className = "kb-xps-text";
      pre.textContent = texts.join("\n");
      section.appendChild(pre);
    }
    wrap.appendChild(section);
  }
  ctx.container.replaceChildren(wrap);
  const pager = trackPages({
    scroller: ctx.container,
    pages: () => Array.from(wrap.querySelectorAll<HTMLElement>(".kb-xps-page")),
    report: (state) => ctx.onPaging?.(state),
  });
  pager.refresh();
  return withFind(ctx, {
    reveal: (page) => pager.reveal(page),
    destroy: () => pager.destroy(),
  });
}

/** XMind：content.json → 层级列表。 */
async function renderXmind(ctx: PreviewContext): Promise<PreviewInstance> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await ctx.readBytes());
  const contentFile = zip.file("content.json");
  if (!contentFile) throw new Error("不支持的 XMind 版本（缺少 content.json）");
  const sheets = JSON.parse(await contentFile.async("string")) as {
    title?: string;
    rootTopic?: { title?: string; children?: { attached?: XmindTopic[] } };
  }[];

  const wrap = document.createElement("div");
  wrap.className = "kb-xmind";
  const renderTopic = (topic: XmindTopic, depth: number, parent: HTMLElement): void => {
    const item = document.createElement("li");
    item.className = `kb-xmind-topic depth-${Math.min(depth, 5)}`;
    item.textContent = topic.title ?? "(无标题)";
    parent.appendChild(item);
    const children = topic.children?.attached ?? [];
    if (children.length === 0) return;
    const list = document.createElement("ul");
    item.appendChild(list);
    for (const child of children) renderTopic(child, depth + 1, list);
  };
  for (const sheet of sheets) {
    const section = document.createElement("section");
    section.className = "kb-xmind-sheet";
    const title = document.createElement("h3");
    title.textContent = sheet.title ?? "画布";
    section.appendChild(title);
    const list = document.createElement("ul");
    if (sheet.rootTopic) renderTopic(sheet.rootTopic, 0, list);
    section.appendChild(list);
    wrap.appendChild(section);
  }
  ctx.container.replaceChildren(wrap);
  return withFind(ctx);
}

/** drawio：mxGraphModel → 顶点框与标签。 */
async function renderDrawio(ctx: PreviewContext): Promise<PreviewInstance> {
  const text = await ctx.readText();
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const cells = Array.from(doc.getElementsByTagName("mxCell"));
  const wrap = document.createElement("div");
  wrap.className = "kb-drawio";
  wrap.appendChild(note("示意图：顶点框与标签（连线路由与样式不在本期范围）"));

  let maxX = 0;
  let maxY = 0;
  const boxes: { x: number; y: number; w: number; h: number; label: string }[] = [];
  for (const cell of cells) {
    if (cell.getAttribute("vertex") !== "1") continue;
    const geometry = cell.getElementsByTagName("mxGeometry")[0];
    if (!geometry) continue;
    const x = Number(geometry.getAttribute("x") ?? "0");
    const y = Number(geometry.getAttribute("y") ?? "0");
    const w = Number(geometry.getAttribute("width") ?? "120");
    const h = Number(geometry.getAttribute("height") ?? "40");
    const label = cell.getAttribute("value") ?? "";
    boxes.push({ x, y, w, h, label });
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }
  const canvas = document.createElement("div");
  canvas.className = "kb-drawio-canvas";
  canvas.style.width = `${maxX + 40}px`;
  canvas.style.height = `${maxY + 40}px`;
  for (const box of boxes) {
    const el = document.createElement("div");
    el.className = "kb-drawio-box";
    el.style.left = `${box.x + 20}px`;
    el.style.top = `${box.y + 20}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    el.textContent = box.label.replace(/<[^>]*>/g, "");
    canvas.appendChild(el);
  }
  wrap.appendChild(canvas);
  ctx.container.replaceChildren(wrap);
  return withFind(ctx);
}

interface XmindTopic {
  title?: string;
  children?: { attached?: XmindTopic[] };
}

export const epubPlugin = {
  tools: ["find"] satisfies PreviewTool[], id: "epub", extensions: EPUB_EXTENSIONS, matchHead: (head: Uint8Array) => startsWith(head, OPC_MAGIC), render: renderEpub };
export const xpsPlugin = {
  tools: ["find"] satisfies PreviewTool[], id: "xps", extensions: XPS_EXTENSIONS, matchHead: (head: Uint8Array) => startsWith(head, OPC_MAGIC), render: renderXps };
export const xmindPlugin = {
  tools: ["find"] satisfies PreviewTool[], id: "xmind", extensions: XMIND_EXTENSIONS, matchHead: (head: Uint8Array) => startsWith(head, OPC_MAGIC), render: renderXmind };
export const drawioPlugin = {
  tools: ["find"] satisfies PreviewTool[], id: "drawio", extensions: DRAWIO_EXTENSIONS, render: renderDrawio };
