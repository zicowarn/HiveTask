// @vitest-environment jsdom
/**
 * 缩放：数学部分（适应窗口 / 档位）与面板接线（控件只在支持的格式上出现）。
 *
 * 「适应窗口」的口径是用户明确要的：**整幅可见 + 四周留约 10% 空白**，
 * 所以这里守的是"取宽高两个方向的较小比 × (1-2×10%)"，而不是某种感觉。
 */
import { describe, expect, it } from "vitest";
import {
  FIT_MARGIN,
  fitScale,
  percentLabel,
  stepZoom,
  ZOOM_STEPS,
  ZoomController,
} from "../src/knowledge/preview/zoom";

describe("适应窗口", () => {
  it("四周留 5%（2026-09-19 口径，由 10% 收紧）：可用区 = 视口的 90%", () => {
    // 1000×1000 的视口 → 可用 900×900（每边 5%）；内容 1600×800 → 取较小的 0.5625
    expect(fitScale({ width: 1600, height: 800 }, { width: 1000, height: 1000 })).toBeCloseTo(0.5625, 6);
    expect(FIT_MARGIN).toBeCloseTo(0.05, 6);
  });

  it("高度受限时按高度算（竖图不会溢出）", () => {
    // 视口 1000×500 → 可用 900×450；内容 400×800 → min(2.25, 0.5625) = 0.5625
    expect(fitScale({ width: 400, height: 800 }, { width: 1000, height: 500 })).toBeCloseTo(0.5625, 6);
  });

  it("小图也按比例放大铺满可用区（与 Preview.app / 浏览器图片视图一致）", () => {
    // 视口 1000×800 → 可用 900×720；内容 100×100 → 高度先受限：min(9, 7.2) = 7.2
    expect(fitScale({ width: 100, height: 100 }, { width: 1000, height: 800 })).toBeCloseTo(7.2, 6);
  });

  it("尺寸还没量出来（0）时返回 1，不产生 0/Infinity", () => {
    expect(fitScale({ width: 0, height: 0 }, { width: 100, height: 100 })).toBe(1);
    expect(fitScale({ width: 100, height: 100 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("档位", () => {
  it("放大/缩小按档走，端点不越界", () => {
    expect(stepZoom(1, "in")).toBeCloseTo(1.25, 6);
    expect(stepZoom(1, "out")).toBeCloseTo(0.75, 6);
    expect(stepZoom(ZOOM_STEPS[ZOOM_STEPS.length - 1], "in")).toBe(ZOOM_STEPS[ZOOM_STEPS.length - 1]);
    expect(stepZoom(ZOOM_STEPS[0], "out")).toBe(ZOOM_STEPS[0]);
  });

  it("从任意值都能往上/往下走一档（适应算出来的 0.37 这类值）", () => {
    expect(stepZoom(0.37, "in")).toBeCloseTo(0.5, 6);
    expect(stepZoom(0.37, "out")).toBeCloseTo(0.33, 6);
  });
});

describe("百分比显示", () => {
  it("10% 以下留一位小数，其余取整", () => {
    expect(percentLabel(0.075)).toBeCloseTo(7.5, 6);
    expect(percentLabel(0.5)).toBe(50);
    expect(percentLabel(1.253)).toBe(125);
  });
});

describe("PDF 文字行拼接（中文 PDF 一汉字一文字项，必须拼行才能搜到词）", () => {
  const run = (str: string, x: number, y: number, width: number, hasEOL = false) => ({
    str,
    hasEOL,
    x,
    y,
    width,
    height: 12,
  });

  it("同一行的多个文字项拼成一行，并记录偏移（用于把命中映射回矩形）", async () => {
    const { joinLines } = await import("../src/knowledge/preview/plugins/pdf");
    const lines = joinLines([
      run("河", 10, 100, 12),
      run("南", 22, 100, 12),
      run("神马", 34, 100, 24, true),
      run("第二行", 10, 130, 36, true),
    ]);
    expect(lines.map((l) => l.text)).toEqual(["河南神马", "第二行"]);
    // "神马" 在行内的偏移是 2..4
    const hit = lines[0].runs.find((piece) => piece.run.text === "神马")!;
    expect([hit.start, hit.end]).toEqual([2, 4]);
  });

  it("空文字项不产生空行，但 hasEOL 要触发换行", async () => {
    const { joinLines } = await import("../src/knowledge/preview/plugins/pdf");
    const lines = joinLines([run("A", 0, 0, 10), run("", 0, 0, 0, true), run("B", 0, 20, 10)]);
    expect(lines.map((l) => l.text)).toEqual(["A", "B"]);
  });
});

describe("ZoomController：百分比以「适应窗口」为 100%", () => {
  const make = (content: { width: number; height: number }, viewport: { width: number; height: number }, allowUpscale = true) => {
    const applied: number[] = [];
    const reported: { percent: number; fit: boolean }[] = [];
    const controller = new ZoomController({
      content: () => content,
      viewport: () => viewport,
      allowUpscale,
      apply: (scale) => void applied.push(scale),
      report: (state) => void reported.push(state),
    });
    return { controller, applied, reported };
  };

  it("打开即 100%（= 适应窗口），不是绝对比例", async () => {
    // 竖版内容放进宽视口：绝对比例只有 0.4 左右，但用户看到的必须是 100%
    const { controller, applied, reported } = make({ width: 600, height: 1200 }, { width: 1000, height: 600 });
    controller.fit();
    expect(applied.at(-1)).toBeCloseTo(0.45, 6); // 可用高 540 / 1200
    expect(reported.at(-1)).toMatchObject({ percent: 100, fit: true, mode: "page" });
    expect(controller.scale).toBeCloseTo(1, 6);
  });

  it("放大一档 = 基准上加 25%，不是绝对 1.25", async () => {
    const { controller, applied, reported } = make({ width: 600, height: 1200 }, { width: 1000, height: 600 });
    controller.fit();
    controller.step("in");
    expect(applied.at(-1)).toBeCloseTo(0.45 * 1.25, 6);
    expect(reported.at(-1)).toMatchObject({ percent: 125, fit: false, mode: null });
  });

  it("缩小有下限，放大有上限（不会缩到看不见 / 放到失控）", async () => {
    const { controller } = make({ width: 100, height: 100 }, { width: 1000, height: 1000 });
    controller.fit();
    for (let i = 0; i < 30; i += 1) controller.step("out");
    expect(controller.scale).toBeCloseTo(ZOOM_STEPS[0], 6);
    for (let i = 0; i < 30; i += 1) controller.step("in");
    expect(controller.scale).toBeCloseTo(ZOOM_STEPS[ZOOM_STEPS.length - 1], 6);
  });

  it("位图不放大超过自然尺寸（小图不拉满屏）", async () => {
    const { controller, applied, reported } = make({ width: 200, height: 100 }, { width: 1000, height: 800 }, false);
    controller.fit();
    expect(applied.at(-1)).toBe(1); // 不放大
    expect(reported.at(-1)).toMatchObject({ percent: 100, fit: true, mode: "page" });
  });

  it("窗口变大变小时：适应模式下自动重算，放大模式下保持相对比例", async () => {
    const viewport = { width: 1000, height: 600 };
    const content = { width: 600, height: 1200 };
    const { controller, applied } = make(content, viewport);
    controller.fit();
    expect(applied.at(-1)).toBeCloseTo(0.45, 6);
    viewport.width = 2000; // 只有宽度变了：适应仍按高度受限 → 比例不变
    controller.refit();
    expect(applied.at(-1)).toBeCloseTo(0.45, 6);
    controller.step("in");
    const zoomed = applied.at(-1)!;
    viewport.height = 1200; // 高度翻倍 → 适应比例翻倍，相对比例不变
    controller.refit();
    expect(applied.at(-1)).toBeCloseTo(zoomed * 2, 6);
  });
});

describe("文档类基准：适应宽度 = 100%（宽面板里打开就能读）", () => {
  it("基准口径 width：100% 时横向铺满（竖版页面两侧不留大空白）", async () => {
    const applied: number[] = [];
    // 竖版页面 600×1200，宽面板 1200×700
    const controller = new ZoomController({
      content: () => ({ width: 600, height: 1200 }),
      viewport: () => ({ width: 1200, height: 700 }),
      anchor: "width",
      apply: (scale) => void applied.push(scale),
    });
    controller.fit();
    // 适应宽度：可用宽 1080（= 1200×0.9）→ 1.8（页面横向铺满，竖向滚动）
    expect(applied.at(-1)).toBeCloseTo(1080 / 600, 6);
    expect(controller.scale).toBeCloseTo(1, 6);
    expect(controller.fitMode).toBe("width");
  });

  it("「适应页面」是相对基准的另一个值（菜单里显示 55%，而不是又是 100%）", async () => {
    const controller = new ZoomController({
      content: () => ({ width: 600, height: 1200 }),
      viewport: () => ({ width: 1200, height: 700 }),
      anchor: "width",
      apply: () => {},
    });
    controller.fit(); // 适应宽度 = 100%
    const pageRelative = controller.relativeFor("page");
    // 适应页面受高度限制：可用高 630 / 1200 = 0.525；相对 1.8 → 0.29
    expect(pageRelative).toBeCloseTo(630 / 1200 / (1080 / 600), 4);
    controller.fit("page");
    expect(controller.scale).toBeCloseTo(pageRelative, 6);
    expect(controller.fitMode).toBe("page");
  });
});
