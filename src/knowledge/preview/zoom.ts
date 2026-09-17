/**
 * 缩放：视图类预览的共用逻辑（图片 / CAD / PDF / 3D 都走这里）。
 *
 * 两条约定：
 * - **「适应窗口」= 整幅可见 + 四周留白 10%** —— 这正是用户要的"自动，上下或者左右留 10% 空白"，
 *   所以取宽高两个方向的较小缩放比；命名沿用 Preview.app 的「适应窗口」；
 * - **缩放用重排（改 width/height）而不是 transform scale**：SVG 是矢量，
 *   重排后任意倍率都清晰；transform 会把位图放大糊掉，且滚动区域尺寸要另算。
 *   （OFD/XPS 那种"绝对定位坐标"的文档不适用，它们走自己的 fit。）
 */

/** 适应窗口时四周留白比例。 */
export const FIT_MARGIN = 0.1;

/** 常用档位（放大/缩小按档位走，避免 1.03 这种脏数字）。 */
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];

export interface Size {
  width: number;
  height: number;
}

/**
 * 「适应」的两种口径：
 * - `width`：**适应宽度** —— 横向铺满、竖向滚动。文档类（PDF/OFD/XPS）用它当基准：
 *   竖版页面在宽面板里"整页适应"会留下两大片空白，字小得没法读（用户实测反馈）；
 * - `page`：**适应页面** —— 整幅可见 + 四周留白。图片 / CAD / 3D 用它，
 *   它们的画面本就该一眼看全。
 */
export type FitMode = "width" | "page";

/** 某种「适应」口径下的绝对缩放比；视口尺寸为 0 时返回 1，避免 0/Infinity。 */
export function fitScaleFor(mode: FitMode, content: Size, viewport: Size, margin = FIT_MARGIN): number {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1;
  const usableWidth = viewport.width * (1 - margin * 2);
  const usableHeight = viewport.height * (1 - margin * 2);
  const byWidth = usableWidth / content.width;
  return mode === "width" ? byWidth : Math.min(byWidth, usableHeight / content.height);
}

/** 适应页面（整幅可见）—— 沿用旧名，语义不变。 */
export function fitScale(content: Size, viewport: Size, margin = FIT_MARGIN): number {
  return fitScaleFor("page", content, viewport, margin);
}

/** 按档位取上/下一档；已在端点则停在端点。 */
export function stepZoom(current: number, direction: "in" | "out"): number {
  const epsilon = 1e-4;
  if (direction === "in") {
    const next = ZOOM_STEPS.find((step) => step > current + epsilon);
    return next ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  const lower = [...ZOOM_STEPS].reverse().find((step) => step < current - epsilon);
  return lower ?? ZOOM_STEPS[0];
}

/** 显示用百分比（10% 以下不显示小数）。 */
export function percentLabel(scale: number): number {
  const percent = scale * 100;
  return percent < 10 ? Math.round(percent * 10) / 10 : Math.round(percent);
}

export interface ZoomControllerOptions {
  /** 内容的自然尺寸（图片是像素，CAD 是图纸单位换算后的值）。 */
  content: () => Size;
  /** 可用视口（元素变了要调 `refit()`）。 */
  viewport: () => Size;
  /**
   * 允许放大到超过自然尺寸吗。
   * 矢量（SVG/CAD）可以——放大更清晰；**位图默认不允许**：把小图拉满屏只会糊。
   */
  allowUpscale?: boolean;
  /** 落地尺寸（插件自己决定改什么：SVG 的 style.width、PDF 的页宽…），入参是**绝对比例**。 */
  apply: (absoluteScale: number) => void;
  /** 基准口径：`width` = 适应宽度（文档类），`page` = 适应页面（图片/CAD/3D）。 */
  anchor?: FitMode;
  /** 状态回报（面板显示百分比）。`mode` 非空表示正处在某个「适应」上。 */
  report?: (state: { percent: number; fit: boolean; mode?: FitMode | null }) => void;
}

/**
 * 缩放控制器 —— **百分比以「适应窗口」为 100% 的基准**。
 *
 * 这是用户明确的口径：打开任何视图类文件时，你看到的就是 100%；
 * 「适应窗口」= 整幅可见 + 四周留 10%；放大/缩小在这条基准上按档位走。
 * （绝对比例那套的问题是：竖版 PDF 适应后显示 47%，填满宽度要手点到 150%，
 * 用户读不懂这个数字。）
 */
export class ZoomController {
  private relative = 1;
  /** 基准口径下的绝对比例（相对值 1 对应的绝对比例）。 */
  private anchorScale = 1;
  /** 当前正处在哪个「适应」上（null = 手动缩放）。 */
  private mode: FitMode | null = null;

  constructor(private readonly options: ZoomControllerOptions) {}

  /** 当前相对比例（1 = 基准口径的适应 = 100%）。 */
  get scale(): number {
    return this.relative;
  }

  get isFit(): boolean {
    return this.mode !== null;
  }

  /** 当前所在的「适应」口径（面板据此打勾）。 */
  get fitMode(): FitMode | null {
    return this.mode;
  }

  /** 基准口径。 */
  get anchor(): FitMode {
    return this.options.anchor ?? "page";
  }

  /** 某个「适应」口径相对基准的比例（菜单里显示"适应页面 74%"用）。 */
  relativeFor(mode: FitMode): number {
    if (this.anchorScale <= 0) return 1;
    return this.scaleFor(mode) / this.anchorScale;
  }

  private scaleFor(mode: FitMode): number {
    const raw = fitScaleFor(mode, this.options.content(), this.options.viewport());
    return this.options.allowUpscale === false ? Math.min(raw, 1) : raw;
  }

  /** 重算基准比例并按当前状态落地（窗口尺寸变化时调用）。 */
  refit(): void {
    this.anchorScale = this.scaleFor(this.anchor);
    if (this.mode) this.commit(this.relativeFor(this.mode), this.mode);
    else this.commit(this.relative, null);
  }

  /** 回到某个「适应」（默认基准口径，= 100%）。 */
  fit(mode: FitMode = this.anchor): void {
    this.anchorScale = this.scaleFor(this.anchor);
    this.commit(this.relativeFor(mode), mode);
  }

  /** 按档位放大/缩小（相对基准）。 */
  step(direction: "in" | "out"): void {
    this.commit(stepZoom(this.relative, direction), null);
  }

  private commit(relative: number, mode: FitMode | null): void {
    this.relative = relative;
    this.mode = mode;
    this.options.apply(this.anchorScale * relative);
    this.options.report?.({ percent: percentLabel(relative), fit: mode !== null, mode });
  }
}
