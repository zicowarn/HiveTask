/**
 * 绘图纯几何：坐标换算 / 矩形规整 / 箭头头部 / 脏矩形。
 * 全部无副作用——Vitest 直测，画布组件只做调用。
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 屏幕（客户区）坐标 → 画布（自然像素）坐标。scale = 显示尺寸 / 自然尺寸。 */
export function toCanvasPoint(clientX: number, clientY: number, paperLeft: number, paperTop: number, scale: number): Pt {
  const s = scale > 0 ? scale : 1;
  return { x: (clientX - paperLeft) / s, y: (clientY - paperTop) / s };
}

/** 拖拽两点 → 规整矩形（负向拖拽归正）；pad 外扩（线宽余量）。 */
export function rectBetween(a: Pt, b: Pt, pad = 0): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  return { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 };
}

/** 矩形并集（多段笔画合并脏区用）。 */
export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

/** 夹回画布范围（越界部分裁掉；完全出界时 w/h 允许为 0，调用方据此跳过）。 */
export function clampRect(r: Rect, canvasW: number, canvasH: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(canvasW, Math.ceil(r.x + r.w));
  const y1 = Math.min(canvasH, Math.ceil(r.y + r.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * 自由笔画的脏矩形：点集包围盒 + 线宽一半外扩 + 1px 余量，最后夹回画布。
 * 空点集返回 null（调用方跳过 patch）。
 */
export function strokeBBox(points: Pt[], width: number, canvasW: number, canvasH: number): Rect | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = width / 2 + 1;
  return clampRect({ x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }, canvasW, canvasH);
}

/**
 * 箭头头部的两条短线端点：以 to 为尖端，向 from 方向张开约 ±32°。
 * size 为头的长度（画布像素，通常取笔宽 × 4）。
 */
export function arrowHead(from: Pt, to: Pt, size: number): [Pt, Pt] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI * 0.18;
  return [
    { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) },
    { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) },
  ];
}

/**
 * 文字块的脏矩形：以基线起点 (x, y)（textBaseline = top）、按行渲染时的包围盒。
 * 行高 = fontSize × 1.35；宽度取各行测量值的最大值。调用方传入测量结果避免这里碰 canvas。
 */
export function textBox(x: number, y: number, fontSize: number, maxLineWidth: number, lineCount: number): Rect {
  return { x, y, w: Math.max(maxLineWidth, 1), h: Math.max(lineCount * fontSize * 1.35, 1) };
}
