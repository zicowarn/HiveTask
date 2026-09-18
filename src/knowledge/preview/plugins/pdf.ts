/**
 * PDF 预览 —— 本地资源版（**无 CDN**）。
 *
 * 与 open-file-viewer 的差别（逐条排除其默认实现的问题）：
 * - OFV 把 `cMapUrl` / `standardFontDataUrl` / `workerSrc` 兜底到 jsdelivr —— 离线即失效；
 *   这里全部指向随包资源（vite 静态拷贝到 `/pdfjs/…`，见 vite.config.ts）；
 * - **中文的关键**就是 cmaps（CID→Unicode 映射）与标准字体：缺了会整篇乱码或白页；
 * - 渲染方式与 OFV 一致：连续滚动 + 惰性渲染可见页（IntersectionObserver），
 *   缩放用 CSS 变量整体缩放（不重排），页面本身按 devicePixelRatio 放大绘制保证清晰。
 */
import type {
  PreviewContext,
  PreviewFindOptions,
  PreviewFindResult,
  PreviewInstance,
  PreviewOutlineItem,
  PreviewTool,
} from "../registry";
import { ZoomController, type Size } from "../zoom";
import { scrollToElement } from "../paging";

/** 文字项在**页坐标系（scale=1）**下的矩形与文本。 */
interface TextRun {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextLine {
  text: string;
  /** 该行由哪些文字项拼成（保持顺序），用于把命中位置映射回具体矩形。 */
  runs: { run: TextRun; start: number; end: number }[];
}

/**
 * 把 pdfjs 的文字项拼成**行**，并记录每个文字项在行文本里的偏移。
 *
 * 为什么要拼：中文 PDF 常常**一个汉字一个文字项**，"搜索一个词"时若逐项匹配
 * 永远搜不到跨项的词。拼行后按偏移找回矩形，命中的高亮就能覆盖整段。
 */
export function joinLines(items: { str: string; hasEOL?: boolean; x: number; y: number; width: number; height: number }[]): TextLine[] {
  const lines: TextLine[] = [];
  let current: TextLine = { text: "", runs: [] };
  const push = (): void => {
    if (current.text.trim()) lines.push(current);
    current = { text: "", runs: [] };
  };
  for (const item of items) {
    if (!item.str) {
      if (item.hasEOL) push();
      continue;
    }
    const start = current.text.length;
    current.text += item.str;
    current.runs.push({
      run: { text: item.str, x: item.x, y: item.y, width: item.width, height: item.height },
      start,
      end: current.text.length,
    });
    if (item.hasEOL) push();
  }
  push();
  return lines;
}

interface PdfMatch {
  page: number;
  /** 命中矩形（页坐标系）—— 缩放时再乘比例，所以存原始坐标。 */
  rects: { x: number; y: number; width: number; height: number }[];
}

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDocument = import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy;

let pdfjsModule: Promise<PdfJsModule> | undefined;

async function loadPdfjs(): Promise<PdfJsModule> {
  pdfjsModule ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = await pdfjsModule;
  // worker 也走随包资源（Vite 会把 worker 文件作为 asset 输出）
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  return pdfjs;
}

/** 单页渲染：按 dpr 提升分辨率，页宽由容器决定。 */
async function renderPage(
  doc: PdfDocument,
  pageNumber: number,
  width: number,
  dpr: number,
  host: HTMLElement,
): Promise<void> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: (width / base.width) * dpr });
  const canvas = document.createElement("canvas");
  canvas.className = "pdf-page";
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建画布上下文");
  await page.render({ canvasContext: context, viewport }).promise;
  host.replaceChildren(canvas);
}

/**
 * 取一页的文字行（含"把 pdfjs 的变换矩阵搬到页坐标"这一步）。
 * pdfjs 的 textItem.transform 是 [a,b,c,d,e,f]，其中 e/f 是基线起点，
 * 字号 = |(c,d)|，宽 = item.width，高 = item.height（均为文本空间单位）。
 */
async function pageLines(doc: PdfDocument, pageNumber: number): Promise<TextLine[]> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();
  const items = content.items
    .filter((item): item is Extract<typeof item, { str: string }> => "str" in item)
    .map((item) => {
      const [, , c, d, e, f] = item.transform as number[];
      const height = item.height || Math.hypot(c, d);
      return {
        str: item.str,
        hasEOL: (item as { hasEOL?: boolean }).hasEOL,
        x: e,
        // transform 的 f 是基线；矩形左上角要上移一个字高
        y: f - height,
        width: item.width,
        height,
      };
    });
  return joinLines(items);
}

export const pdfPlugin = {
  id: "pdf",
  extensions: ["pdf"],
  tools: ["zoom", "find", "outline"] satisfies PreviewTool[],
  zoomModes: ["width", "page"] satisfies ("width" | "page")[],
  matchHead: (head: Uint8Array) => head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46,
  // 扩展名是 pdf 但内容不是 → 不认领，交给 magic 通道（"改名/伪造扩展名"两个方向都覆盖）
  headGuarded: ["pdf"],
  async render(ctx: PreviewContext): Promise<PreviewInstance> {
    const pdfjs = await loadPdfjs();
    const bytes = await ctx.readBytes();
    // 销毁要落在 loadingTask 上（PDFDocumentProxy 只有 cleanup，没有 destroy）
    const loadingTask = pdfjs.getDocument({
      data: bytes,
      // ↓↓↓ 三条本地化（OFV 默认指向 CDN，离线就废）
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      useSystemFonts: true,
    });
    const doc = await loadingTask.promise;

    const scroller = document.createElement("div");
    scroller.className = "pdf-scroller";
    const pages = document.createElement("div");
    pages.className = "pdf-pages";
    scroller.appendChild(pages);
    ctx.container.replaceChildren(scroller);

    // 第一页的原始尺寸：所有缩放都以它为基准
    const first = await doc.getPage(1);
    const firstViewport = first.getViewport({ scale: 1 });
    const natural: Size = { width: firstViewport.width, height: firstViewport.height };
    const ratio = natural.height / natural.width;

    const holders: HTMLElement[] = [];
    for (let index = 1; index <= doc.numPages; index += 1) {
      const holder = document.createElement("div");
      holder.className = "pdf-page-holder";
      holder.dataset.page = String(index);
      holders.push(holder);
      pages.appendChild(holder);
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rendered = new Set<number>();
    let scale = 1;
    // 查找状态要在 layout 之前就位：首次 fit 会重排并重画高亮
    const linesByPage = new Map<number, TextLine[]>();
    let matches: PdfMatch[] = [];
    let currentMatch = 0;
    let queryKey = "";

    /** 视口可用尺寸（去掉页面之间与首末页的留白）。 */
    const viewport = (): Size => ({ width: scroller.clientWidth, height: scroller.clientHeight });

    /**
     * 按当前缩放重排：占位框高度、页面宽度、已渲染集合都要重置
     * （PDF 的文字是画在 canvas 上的，缩放必须**重画**，不像 SVG 能靠重排变清晰）。
     */
    const layout = (next: number): void => {
      scale = next;
      const width = Math.max(80, natural.width * scale);
      for (const holder of holders) {
        holder.style.width = `${Math.round(width)}px`;
        holder.style.height = `${Math.round(width * ratio)}px`;
      }
      rendered.clear();
      for (const holder of holders) holder.replaceChildren();
      // 已进入视口的页立刻重画（观察器只会在交叉状态变化时回调，不重画会留白）
      for (const holder of holders) {
        const rect = holder.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        if (rect.bottom > box.top - 400 && rect.top < box.bottom + 400) {
          paint(Number(holder.dataset.page), holder);
        }
      }
      paintMatches();
    };

    const paint = (pageNumber: number, holder: HTMLElement): void => {
      if (rendered.has(pageNumber)) return;
      rendered.add(pageNumber);
      const width = Math.max(80, natural.width * scale);
      void renderPage(doc, pageNumber, width, dpr, holder).catch((error: unknown) => {
        holder.textContent = String(error);
        holder.classList.add("pdf-page-error");
      });
    };

    /** 适应窗口：整页可见（含高度），四周留 10% —— 与图片/CAD 同一套口径。 */
    const controller = new ZoomController({
      content: () => natural,
      viewport,
      // 文档类基准 = **适应宽度**：竖版页面在宽面板里铺满横向、竖向滚动，
      // 这才是"打开就能读"；整页适应留给菜单里的「适应页面」
      anchor: "width",
      apply: (absolute) => layout(absolute),
      report: (state) => ctx.onZoom?.(state),
    });

    // 可见页惰性渲染；**功能探测照 OFV `pdf.ts`**：引擎没有 IntersectionObserver 时
    // （jsdom / 老 WebView）退化成"全部立即渲染"，而不是在这里抛错导致整个文件打不开。
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (records) => {
              for (const record of records) {
                if (!record.isIntersecting) continue;
                paint(Number((record.target as HTMLElement).dataset.page), record.target as HTMLElement);
              }
            },
            { root: scroller, rootMargin: "400px 0px" },
          );
    if (observer) {
      for (const holder of holders) observer.observe(holder);
    } else {
      for (const holder of holders) paint(Number(holder.dataset.page), holder);
    }

    // 初次进入按"适应窗口"（= 100%）
    controller.fit();
    ctx.onPaging?.({ page: 1, total: doc.numPages });

    // ---- 大纲（书签树）：没有书签的 PDF 给空数组，面板按钮会照常出现但列表为空 ----
    const outline: PreviewOutlineItem[] = [];
    const rawOutline = await doc.getOutline().catch(() => null);
    const walkOutline = (nodes: NonNullable<typeof rawOutline>, level: number): void => {
      for (const node of nodes) {
        const dest = node.dest;
        void dest;
        // 先占位（0 = 还没解析出目标页）；解析失败时保持 0 —— 点了不跳，
        // 总好过跳到"第 N 条书签"对应的错误页码上
        outline.push({ level, title: String(node.title ?? "").trim() || "(无标题)", target: 0 });
        if (node.items?.length) walkOutline(node.items, level + 1);
      }
    };
    if (rawOutline) walkOutline(rawOutline, 1);
    // 把书签的 dest 解析成页码（pdfjs 6 需要显式 resolve；4.x 用 getDestination/getPageIndex）
    const resolveDest = async (dest: unknown): Promise<number | null> => {
      try {
        const explicit = typeof dest === "string" ? await doc.getDestination(dest) : (dest as unknown[] | null);
        const ref = explicit?.[0];
        if (!ref) return null;
        const index = await doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0]);
        return index + 1;
      } catch {
        return null;
      }
    };
    if (rawOutline) {
      let cursor = 0;
      const assign = async (nodes: NonNullable<typeof rawOutline>): Promise<void> => {
        for (const node of nodes) {
          const page = await resolveDest(node.dest);
          if (page) outline[cursor].target = page;
          cursor += 1;
          if (node.items?.length) await assign(node.items);
        }
      };
      await assign(rawOutline);
    }

    // ---- 查找：首次调用时建全文索引（按页缓存），命中存"页坐标"下的矩形 ----
    const lineCache = async (pageNumber: number): Promise<TextLine[]> => {
      const cached = linesByPage.get(pageNumber);
      if (cached) return cached;
      const lines = await pageLines(doc, pageNumber);
      linesByPage.set(pageNumber, lines);
      return lines;
    };

    /** 一次命中的矩形集合：把行内偏移区间映射回文字项（跨项也要覆盖全）。 */
    const rectsFor = (line: TextLine, start: number, end: number): PdfMatch["rects"] => {
      const rects: PdfMatch["rects"] = [];
      for (const piece of line.runs) {
        const from = Math.max(start, piece.start);
        const to = Math.min(end, piece.end);
        if (to <= from) continue;
        // 按字符比例切分该项的宽度（等宽近似；中文等宽、拉丁词内差异极小）
        const ratio = (chunk: number): number => (piece.run.text.length ? chunk / piece.run.text.length : 0);
        const offset = ratio(from - piece.start) * piece.run.width;
        rects.push({
          x: piece.run.x + offset,
          y: piece.run.y,
          width: Math.max(ratio(to - from) * piece.run.width, 1),
          height: piece.run.height,
        });
      }
      return rects;
    };

    /** 把命中画在页面上（叠加层，随缩放重画）。函数声明以提升，layout 里可安全调用。 */
    function paintMatches(): void {
      for (const holder of holders) {
        const pageNumber = Number(holder.dataset.page);
        for (const el of Array.from(holder.querySelectorAll(".pdf-hit"))) el.remove();
        if (!matches.length) continue;
        const pageMatches = matches
          .map((match, index) => ({ match, index }))
          .filter(({ match }) => match.page === pageNumber);
        for (const { match, index } of pageMatches) {
          for (const rect of match.rects) {
            const box = document.createElement("span");
            box.className = index === currentMatch ? "pdf-hit current" : "pdf-hit";
            box.style.left = `${rect.x * scale}px`;
            box.style.top = `${rect.y * scale}px`;
            box.style.width = `${rect.width * scale}px`;
            box.style.height = `${rect.height * scale}px`;
            holder.appendChild(box);
          }
        }
      }
    }

    /**
     * 当前页 = 视口顶部所在的那一页。滚动时按需上报（状态栏显示「第 N / M 页」）。
     * 用 rAF 合并滚动事件：滚动是高频事件，每次都算会拖慢长文档。
     */
    let pageReportScheduled = false;
    const reportCurrentPage = (): void => {
      if (pageReportScheduled) return;
      pageReportScheduled = true;
      requestAnimationFrame(() => {
        pageReportScheduled = false;
        const scrollerTop = scroller.getBoundingClientRect().top;
        let current = 1;
        for (const holder of holders) {
          const offset = holder.getBoundingClientRect().top - scrollerTop;
          if (offset <= 24) current = Number(holder.dataset.page);
          else break;
        }
        ctx.onPaging?.({ page: current, total: doc.numPages });
      });
    };
    scroller.addEventListener("scroll", reportCurrentPage, { passive: true });

    const scrollToPage = (pageNumber: number): void => {
      const holder = holders[pageNumber - 1];
      if (!holder) return;
      scrollToElement(scroller, holder);
      ctx.onPaging?.({ page: pageNumber, total: doc.numPages });
    };

    const runFind = async (query: string, options: PreviewFindOptions): Promise<PreviewFindResult> => {
      const trimmed = query.trim();
      if (!trimmed) {
        matches = [];
        currentMatch = 0;
        paintMatches();
        queryKey = "";
        return { total: 0, current: 0 };
      }
      const key = `${options.caseSensitive ? "cs" : "ci"}|${options.regexp ? "re" : "li"}|${options.wholeWord ? "ww" : "any"}|${trimmed}`;
      if (key !== queryKey) {
        queryKey = key;
        const found: PdfMatch[] = [];
        // 正则模式：让用户用真正的正则（无效正则当作"无命中"，不抛错打断预览）
        let pattern: RegExp | null = null;
        if (options.regexp) {
          try {
            pattern = new RegExp(trimmed, options.caseSensitive ? "g" : "gi");
          } catch {
            pattern = null;
          }
          if (!pattern) {
            matches = [];
            currentMatch = 0;
            paintMatches();
            return { total: 0, current: 0 };
          }
        }
        // 整词匹配：只在拉丁文上有意义（中文没有词边界），用  包一层
        const wholeWordPattern =
          options.wholeWord && !options.regexp
            ? new RegExp(`\\b${trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, options.caseSensitive ? "g" : "gi")
            : null;
        const needle = options.caseSensitive ? trimmed : trimmed.toLowerCase();

        for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
          for (const line of await lineCache(pageNumber)) {
            if (pattern || wholeWordPattern) {
              const re = pattern ?? wholeWordPattern!;
              re.lastIndex = 0;
              for (let hit = re.exec(line.text); hit; hit = re.exec(line.text)) {
                if (hit[0].length === 0) {
                  re.lastIndex += 1; // 空匹配防死循环
                  continue;
                }
                found.push({ page: pageNumber, rects: rectsFor(line, hit.index, hit.index + hit[0].length) });
              }
              continue;
            }
            const haystack = options.caseSensitive ? line.text : line.text.toLowerCase();
            let from = 0;
            for (;;) {
              const at = haystack.indexOf(needle, from);
              if (at < 0) break;
              found.push({ page: pageNumber, rects: rectsFor(line, at, at + needle.length) });
              from = at + Math.max(needle.length, 1);
            }
          }
        }
        matches = found;
        currentMatch = found.length ? 1 : 0;
      } else {
        // 同一个查询再按"下一个/上一个"：只移动当前命中（含回绕）
        if (matches.length) {
          currentMatch = options.forward
            ? (currentMatch % matches.length) + 1
            : ((currentMatch - 2 + matches.length) % matches.length) + 1;
        }
      }
      paintMatches();
      if (matches.length) scrollToPage(matches[currentMatch - 1].page);
      return { total: matches.length, current: currentMatch };
    };

    return {
      destroy() {
        observer?.disconnect();
        scroller.removeEventListener("scroll", reportCurrentPage);
        void loadingTask.destroy();
      },
      zoom(action) {
        if (action === "fit") controller.fit();
        else if (action === "fit-width") controller.fit("width");
        else if (action === "fit-page") controller.fit("page");
        else controller.step(action);
      },
      outline,
      reveal(target) {
        scrollToPage(target);
      },
      find: runFind,
      findClear() {
        matches = [];
        currentMatch = 0;
        queryKey = "";
        paintMatches();
      },
    };
  },
};
