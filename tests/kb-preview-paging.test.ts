// @vitest-environment jsdom
/**
 * 分页文档的「当前页」跟踪（OFD / XPS / pptx 共用）。
 *
 * 口径：页面在滚动容器里顺序排列，「当前页」= 视口顶部所在（或最近越过顶部的）那一块。
 * jsdom 没有布局，这里给每块打桩 top 值来模拟滚动位置。
 */
import { describe, expect, it, vi } from "vitest";
import { trackPages } from "../src/knowledge/preview/paging";

function setup(tops: number[]) {
  const scroller = document.createElement("div");
  scroller.scrollTo = vi.fn();
  const pages = tops.map((top, index) => {
    const el = document.createElement("section");
    el.className = "kb-page";
    // offsetTop 在 jsdom 里是只读 getter，用 defineProperty 打桩
    Object.defineProperty(el, "offsetTop", { value: top, configurable: true });
    el.getBoundingClientRect = () =>
      ({ top: top - (scroller as unknown as { scrollTop: number }).scrollTop, height: 100 }) as DOMRect;
    el.dataset.page = String(index + 1);
    return el;
  });
  (scroller as unknown as { scrollTop: number }).scrollTop = 0;
  return { scroller, pages };
}

function track(scroller: HTMLElement, pages: HTMLElement[]) {
  const reported: { page: number; total: number }[] = [];
  const pager = trackPages({ scroller, pages: () => pages, report: (state) => reported.push(state) });
  return { pager, reported };
}

describe("trackPages", () => {
  it("初始在第 1 页，总数 = 页块数", () => {
    const { scroller, pages } = setup([0, 400, 800]);
    const { pager, reported } = track(scroller, pages);
    pager.refresh();
    expect(reported.at(-1)).toEqual({ page: 1, total: 3 });
  });

  it("滚到中间 → 当前页跟着变（下一个未越顶的块停止判断）", () => {
    const { scroller, pages } = setup([0, 400, 800]);
    const { pager, reported } = track(scroller, pages);
    (scroller as unknown as { scrollTop: number }).scrollTop = 450;
    pager.refresh();
    expect(reported.at(-1)).toEqual({ page: 2, total: 3 });
    (scroller as unknown as { scrollTop: number }).scrollTop = 900;
    pager.refresh();
    expect(reported.at(-1)).toEqual({ page: 3, total: 3 });
  });

  it("reveal 跳到指定页并回报；越界夹到范围内", () => {
    const { scroller, pages } = setup([0, 400, 800]);
    const { pager, reported } = track(scroller, pages);
    pager.reveal(3);
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 800 - 12 }));
    expect(reported.at(-1)).toEqual({ page: 3, total: 3 });
    pager.reveal(99);
    expect(reported.at(-1)?.page).toBe(3);
    pager.reveal(-5);
    expect(reported.at(-1)?.page).toBe(1);
  });

  it("没有页块时不报状态（避免状态栏出现「第 0 / 0 页」）", () => {
    const { scroller } = setup([]);
    const { pager, reported } = track(scroller, []);
    pager.refresh();
    expect(reported).toEqual([]);
  });

  it("destroy 之后不再响应滚动", () => {
    const { scroller, pages } = setup([0, 400]);
    const { pager, reported } = track(scroller, pages);
    pager.destroy();
    (scroller as unknown as { scrollTop: number }).scrollTop = 500;
    scroller.dispatchEvent(new Event("scroll"));
    expect(reported.length).toBe(0);
  });
});

describe("滚动目标计算（PDF 大纲跳转栽过的地方）", () => {
  it("用 rect 差值算目标位置，不依赖 offsetTop/定位祖先", async () => {
    const { scrollToElement } = await import("../src/knowledge/preview/paging");
    const scroller = document.createElement("div");
    const target = document.createElement("section");
    let asked: ScrollToOptions | null = null;
    scroller.scrollTo = ((options: ScrollToOptions) => {
      asked = options;
    }) as typeof scroller.scrollTo;
    Object.defineProperty(scroller, "scrollTop", { value: 500, writable: true });
    // 视口顶部在 100，目标块顶部在 1250 → 相对偏移 1150，滚到 500+1150-12
    scroller.getBoundingClientRect = () => ({ top: 100, height: 700 }) as DOMRect;
    target.getBoundingClientRect = () => ({ top: 1250, height: 900 }) as DOMRect;

    scrollToElement(scroller, target);
    expect(asked).toMatchObject({ top: 500 + 1150 - 12, behavior: "smooth" });
  });

  it("目标在视口上方时不产生负值", async () => {
    const { scrollToElement } = await import("../src/knowledge/preview/paging");
    const scroller = document.createElement("div");
    const target = document.createElement("section");
    let asked: ScrollToOptions | null = null;
    scroller.scrollTo = ((options: ScrollToOptions) => {
      asked = options;
    }) as typeof scroller.scrollTo;
    Object.defineProperty(scroller, "scrollTop", { value: 0, writable: true });
    scroller.getBoundingClientRect = () => ({ top: 300 }) as DOMRect;
    target.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    scrollToElement(scroller, target);
    expect(asked).toMatchObject({ top: 0 });
  });
});
