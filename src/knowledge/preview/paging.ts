/**
 * 分页文档的「当前页」跟踪 —— OFD / XPS / pptx / PDF 共用一套口径。
 *
 * 前提：页面在滚动容器里是**顺序排列的块**（`.kb-ofd-page`、`.kb-slide`…），
 * 于是"当前页" = 视口顶部所在（或最近越过顶部的）那一块。
 *
 * 为什么不做**字流文档的伪分页**（docx 就是这种）：docx-preview 只在显式分页符处切页，
 * DOM 里的"N 页"跟 Word 实际打印页数不是一回事 —— 标上去就是假信息。
 */
export interface PagingState {
  page: number;
  total: number;
}

export interface PagingTracker {
  /** 跳到第 N 页（1 基；越界会被夹到范围内）。 */
  reveal: (page: number) => void;
  /** 重新量一次当前页（页面块变化后调用）。 */
  refresh: () => void;
  destroy: () => void;
}

export interface TrackPagesOptions {
  scroller: HTMLElement;
  /** 页面元素，按顺序。 */
  pages: () => HTMLElement[];
  report: (state: PagingState) => void;
}

/** 视口顶部往下留一点容差：页面刚好贴顶时也算这一页。 */
const TOP_TOLERANCE = 24;

/**
 * 把元素滚到滚动容器顶部（留 `offset` 空隙）。
 *
 * 用 **rect 差值**而不是 `offsetTop`：`offsetTop` 的基准是"最近的定位祖先"，
 * 而预览的容器链上通常没有定位元素（`offsetParent` 会一路退到 `<body>`），
 * 拿它当滚动目标会跳错位置 —— PDF 大纲点了没反应就是栽在这里。
 */
export function scrollToElement(scroller: HTMLElement, target: HTMLElement, offset = 12): void {
  const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const top = Math.max(0, scroller.scrollTop + delta - offset);
  // scrollTo 在精简 DOM 宿主里可能不存在（jsdom 就没有）—— 直接赋值同样能滚，只是没有动画。
  // 这里不该抛：跳转失败最多是"没动"，把异常抛进面板的 watcher 会连带弄坏那次渲染。
  if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top, behavior: "smooth" });
  else scroller.scrollTop = top;
}

export function trackPages(options: TrackPagesOptions): PagingTracker {
  let scheduled = false;

  const measure = (): void => {
    const scrollerTop = options.scroller.getBoundingClientRect().top;
    const pages = options.pages();
    if (!pages.length) return;
    let current = 1;
    for (const [index, page] of pages.entries()) {
      const offset = page.getBoundingClientRect().top - scrollerTop;
      if (offset <= TOP_TOLERANCE) current = index + 1;
      else break;
    }
    options.report({ page: current, total: pages.length });
  };

  // 滚动是高频事件：用 rAF 合帧，长文档下不拖慢
  const onScroll = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      measure();
    });
  };

  options.scroller.addEventListener("scroll", onScroll, { passive: true });

  return {
    reveal(page: number): void {
      const pages = options.pages();
      const target = pages[Math.min(Math.max(page, 1), pages.length) - 1];
      if (!target) return;
      scrollToElement(options.scroller, target);
      options.report({ page: Math.min(Math.max(page, 1), pages.length), total: pages.length });
    },
    refresh: measure,
    destroy(): void {
      options.scroller.removeEventListener("scroll", onScroll);
    },
  };
}
