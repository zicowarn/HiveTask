/**
 * OFD 预览（中文公文/发票的国标版式文档）—— **自研解析**，参照 OFV 的 ofd 插件思路。
 *
 * OFD 本体是一个 zip：`OFD.xml` → 文档 → 页面列表；每页 `Content.xml` 里是文本/图像对象，
 * 坐标单位是毫米（`PhysicalBox`）或页面尺寸属性。这里做**可达的版面渲染**：
 * - 页面按物理尺寸换算成 CSS 像素（1mm ≈ 3.78px），按比例缩放铺进容器；
 * - 文本对象按 `Boundary` 定位、按 `Size` 设字号（这是能还原公文观感的关键）；
 * - 图像对象（Res 里的图片）按 boundary 贴图。
 *
 * 明确不做的（如实告知，不假装）：字体嵌入还原、矢量图形（Path）的路径绘制、
 * 注释/签章的数字签名校验 —— 这三项需要完整 OFD 渲染栈。
 */
import type { PreviewContext, PreviewInstance, PreviewTool } from "../registry";
import { withFind } from "../dom-find";
import { trackPages } from "../paging";

export const OFD_EXTENSIONS = ["ofd"];

const MM_TO_PX = 96 / 25.4; // CSS 像素与物理毫米的换算

/**
 * 按**本地名**取元素：OFD 规范只规定命名空间 URI，前缀由生成器自定，
 * 实测有 `ofd:`、`ofd1:`、甚至无前缀三种。写死前缀会整份文件都读不出来。
 */
function byLocalName(doc: Document | Element, local: string): Element[] {
  return Array.from(doc.getElementsByTagNameNS("*", local));
}

interface OfdText {
  x: number;
  y: number;
  size: number;
  text: string;
}

/** 从 `Boundary="x y w h"` 取左上角与尺寸（单位：毫米）。 */
function parseBoundary(value: string | null): { x: number; y: number; w: number; h: number } {
  const parts = (value ?? "").trim().split(/\s+/).map(Number);
  return { x: parts[0] ?? 0, y: parts[1] ?? 0, w: parts[2] ?? 0, h: parts[3] ?? 0 };
}

/** 解析一个 Content.xml → 文本集合 + 所用图片引用。 */
function parseContent(xml: string): { texts: OfdText[]; images: { x: number; y: number; w: number; h: number; res: string }[] } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const texts: OfdText[] = [];
  const images: { x: number; y: number; w: number; h: number; res: string }[] = [];

  for (const node of byLocalName(doc, "TextObject")) {
    const boundary = parseBoundary(node.getAttribute("Boundary"));
    const size = Number(node.getAttribute("Size") ?? "3") || 3; // 毫米字号
    const content = Array.from(byLocalName(node, "TextCode"))
      .map((code) => code.textContent ?? "")
      .join("");
    if (!content.trim()) continue;
    texts.push({ x: boundary.x, y: boundary.y, size, text: content });
  }
  for (const node of byLocalName(doc, "ImageObject")) {
    const boundary = parseBoundary(node.getAttribute("Boundary"));
    const res = node.getAttribute("ResourceID") ?? "";
    if (res) images.push({ x: boundary.x, y: boundary.y, w: boundary.w, h: boundary.h, res });
  }
  return { texts, images };
}

export const ofdPlugin = {
  tools: ["find"] satisfies PreviewTool[],
  id: "ofd",
  extensions: OFD_EXTENSIONS,
  async render(ctx: PreviewContext): Promise<PreviewInstance> {
    const JSZip = (await import("jszip")).default;
    const bytes = await ctx.readBytes();
    const zip = await JSZip.loadAsync(bytes);

    const docFile = zip.file("OFD.xml");
    if (!docFile) throw new Error("不是有效的 OFD（缺少 OFD.xml）");
    const docXml = await docFile.async("string");
    const docNode = new DOMParser().parseFromString(docXml, "application/xml");
    const docRoot = byLocalName(docNode, "DocRoot")[0]?.textContent?.trim() ?? "";
    const docPath = docRoot.replace(/^\//, "");
    const docBody = await zip.file(docPath)?.async("string");
    if (!docBody) throw new Error("OFD 文档体缺失");
    // Page/Content 的 BaseLoc 是**相对文档体所在目录**的（如 Doc_0/Document.xml 里
    // 的 "Pages/Page_0/Content.xml" 实际在 Doc_0/Pages/Page_0/Content.xml）——
    // 少了这层前缀就整份文件渲染成空白，是解析 OFD 最容易踩的坑。
    const docDir = docPath.includes("/") ? docPath.slice(0, docPath.lastIndexOf("/") + 1) : "";
    const resolveInDoc = (loc: string): string => {
      const clean = loc.replace(/^\//, "");
      return clean.startsWith(docDir) ? clean : `${docDir}${clean}`;
    };

    const bodyDoc = new DOMParser().parseFromString(docBody, "application/xml");
    const pageNodes = byLocalName(bodyDoc, "Page");
    /**
     * 大纲：OFD 规范里 `ofd:Outline/ofd:OutlineElem` 是**可选的**目录结构，
     * 实名 OFD 常常没有（样本里就没有）→ 那就回退成页列表（「第 N 页」）。
     * 有目录时用它的标题与目标页 —— 总比拿页码冒充章节名强。
     */
    const outlineElems = byLocalName(bodyDoc, "OutlineElem");
    const outlineFromFile = outlineElems.length
      ? outlineElems.map((node) => ({
          level: Math.min(byLocalName(node, "OutlineElem").length ? 2 : 1, 3),
          title: ((node.getAttribute("Title") ?? "").trim() || "未命名目录项"),
          // Dest → DestPage 里的 Page 引用；解析不出就落回第 1 页
          target: Number(
            (node.getElementsByTagNameNS("*", "Page")[0]?.textContent ?? "").replace(/\D/g, ""),
          ) || 1,
        }))
      : null;
    if (pageNodes.length === 0) throw new Error("OFD 里没有页面（可能是加密或非标准实现）");

    const wrap = document.createElement("div");
    wrap.className = "kb-ofd";
    const note = document.createElement("p");
    note.className = "kb-note";
    note.textContent = `共 ${pageNodes.length} 页（文本与图像按原坐标排版；矢量图形与签章不在本期范围）`;
    wrap.appendChild(note);

    // 资源 id → zip 内路径（图片）
    const resourceMap = new Map<string, string>();
    for (const node of byLocalName(docNode, "File")) {
      const id = node.getAttribute("ID");
      const loc = node.textContent?.trim();
      if (id && loc) resourceMap.set(id, loc.replace(/^\//, ""));
    }

    const urlCache = new Map<string, string>();

    for (const page of pageNodes) {
      const physical = parseBoundary(page.getAttribute("PhysicalBox") ?? "0 0 210 297");
      const rawLoc = page.getAttribute("BaseLoc") ?? contentLocOf(page);
      if (!rawLoc) continue;
      const contentFile = zip.file(resolveInDoc(rawLoc)) ?? zip.file(rawLoc.replace(/^\//, ""));
      if (!contentFile) continue;
      const { texts, images } = parseContent(await contentFile.async("string"));

      const pageEl = document.createElement("div");
      pageEl.className = "kb-ofd-page";
      pageEl.style.width = `${physical.w * MM_TO_PX}px`;
      pageEl.style.height = `${physical.h * MM_TO_PX}px`;

      for (const text of texts) {
        const span = document.createElement("span");
        span.className = "kb-ofd-text";
        span.textContent = text.text;
        span.style.left = `${text.x * MM_TO_PX}px`;
        span.style.top = `${text.y * MM_TO_PX}px`;
        span.style.fontSize = `${text.size * MM_TO_PX}px`;
        pageEl.appendChild(span);
      }

      for (const image of images) {
        const rawPath = resourceMap.get(image.res) ?? image.res;
        const path = resolveInDoc(rawPath);
        const file = zip.file(path) ?? zip.file(rawPath.replace(/^\//, ""));
        if (!file) continue;
        let url = urlCache.get(path);
        if (!url) {
          const blob = await file.async("blob");
          url = URL.createObjectURL(blob);
          urlCache.set(path, url);
        }
        const img = document.createElement("img");
        img.className = "kb-ofd-image";
        img.src = url;
        img.style.left = `${image.x * MM_TO_PX}px`;
        img.style.top = `${image.y * MM_TO_PX}px`;
        img.style.width = `${image.w * MM_TO_PX}px`;
        img.style.height = `${image.h * MM_TO_PX}px`;
        pageEl.appendChild(img);
      }
      wrap.appendChild(pageEl);
    }

    ctx.container.replaceChildren(wrap);
    const pages = Array.from(wrap.querySelectorAll<HTMLElement>(".kb-ofd-page"));
    const pager = trackPages({
      scroller: ctx.container,
      pages: () => Array.from(wrap.querySelectorAll<HTMLElement>(".kb-ofd-page")),
      report: (state) => ctx.onPaging?.(state),
    });
    pager.refresh();
    return withFind(ctx, {
      outline:
        outlineFromFile ??
        pages.map((_page, index) => ({ level: 1, title: `第 ${index + 1} 页`, target: index + 1 })),
      reveal: (page) => pager.reveal(page),
      destroy() {
        pager.destroy();
        for (const url of urlCache.values()) URL.revokeObjectURL(url);
      },
    });
  },
};

/** Page 的 Content 通常在单独文件里，由 `ofd:Content` 的 BaseLoc 指定。 */
function contentLocOf(page: Element): string {
  const content = byLocalName(page, "Content")[0];
  return content?.getAttribute("BaseLoc")?.replace(/^\//, "") ?? "";
}
