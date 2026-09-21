<script setup lang="ts">
/**
 * 知识库图片编辑画布（Canvas2D，零依赖）。
 *
 * 三层画布：work（全分辨率、编辑真相）/ overlay（当前笔画预览）/ visible（合成显示）。
 * 提交 = 把 overlay 按工具语义烘进 work（画笔 source-over、橡皮 destination-out、
 * 马赛克就地重画），并记录脏矩形 patch 进撤销栈（history.ts，按字节预算淘汰）。
 *
 * 两条硬约束在这里落地：
 * - **文字工具用 DOM 输入浮层**承接（textarea），不用 canvas 直接收键盘——
 *   那会废掉输入法候选窗（IME 教训同 editor/ime-guard.ts）；Enter 提交前查 isComposing。
 * - 缩放复用 preview/zoom 的 ZoomController（「适应窗口」= 100% 口径，与查看态一致）；
 *   编辑允许放大超过自然尺寸（改细节刚需，位图放大发虚是本性）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ZoomController, type Size } from "../preview/zoom";
import { useI18n } from "../../i18n";
import { pushToast } from "../../toast";
import { floodFill } from "./fill";
import { EditHistory } from "./history";
import {
  arrowHead,
  clampRect,
  rectBetween,
  strokeBBox,
  textBox,
  toCanvasPoint,
  type Pt,
  type Rect,
} from "./geometry";
import { BLANK_CANVAS_SIZE, drawSession } from "./session";

const props = defineProps<{ src: string; /** 空白画布（无源图）：用此尺寸建透明画布。 */ blank?: boolean }>();
const emit = defineEmits<{
  zoom: [state: { percent: number; fit: boolean }];
  error: [message: string];
}>();

const { t } = useI18n();

const stageEl = ref<HTMLElement | null>(null);
const paperEl = ref<HTMLElement | null>(null);
const visibleRef = ref<HTMLCanvasElement | null>(null);
const textEl = ref<HTMLTextAreaElement | null>(null);

/** 显示比例（ZoomController 落地值；文字浮层的字号/位置随它换算）。 */
const scale = ref(1);
/** paper 的 CSS 尺寸（自然尺寸 × scale）。 */
const display = ref<Size>({ width: 0, height: 0 });
const ready = ref(false);

/** 文字草稿（画布坐标 x/y + 屏幕定位 left/top）。 */
const textDraft = ref<{ x: number; y: number; value: string } | null>(null);

let work: HTMLCanvasElement | null = null;
let workCtx: CanvasRenderingContext2D | null = null;
let overlay: HTMLCanvasElement | null = null;
let overlayCtx: CanvasRenderingContext2D | null = null;
let visibleCtx: CanvasRenderingContext2D | null = null;
let sourceImage: HTMLImageElement | null = null;

/** 画布尺寸交给响应式：旋转/裁剪会改它，模板的 paper/三张 canvas 尺寸随动。 */
const canvasSize = ref<Size>({ width: 0, height: 0 });
let W = 0;
let H = 0;
const history = new EditHistory();

/** 马赛克块大小（画布像素）。 */
const MOSAIC_BLOCK = 12;
/** 箭头头部相对笔宽的长度倍数。 */
const ARROW_HEAD_RATIO = 4;
/** 油漆桶容差（吃掉截图抗锯齿过渡带）；纯函数在 fill.ts，可单测。 */
const FILL_TOLERANCE = 48;

/** 空白画布默认尺寸（session.ts 的常量在此展开为模块内变量，避免 prop 再传一路）。 */
const { width: blankWidth, height: blankHeight } = BLANK_CANVAS_SIZE;

// ---- 缩放（与查看态同一套口径：适应窗口 = 100%）----
const zoomController = new ZoomController({
  content: () => ({ width: W, height: H }),
  viewport: (): Size => {
    const box = stageEl.value;
    if (!box) return { width: 0, height: 0 };
    return { width: box.clientWidth, height: box.clientHeight };
  },
  allowUpscale: true,
  apply: (absolute) => {
    scale.value = absolute;
    display.value = { width: Math.max(1, Math.round(W * absolute)), height: Math.max(1, Math.round(H * absolute)) };
  },
  report: (state) => emit("zoom", { percent: state.percent, fit: state.fit }),
});

function zoom(action: "in" | "out" | "fit"): void {
  if (action === "fit") zoomController.fit();
  else zoomController.step(action);
}

function onWheel(event: WheelEvent): void {
  if (!(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  zoom(event.deltaY < 0 ? "in" : "out");
}

let resizeObserver: ResizeObserver | null = null;

// ---- 画布初始化 ----
function initCanvases(): void {
  const visible = visibleRef.value;
  if (!visible) return;
  work = document.createElement("canvas");
  overlay = document.createElement("canvas");
  for (const canvas of [work, overlay, visible]) {
    canvas.width = W;
    canvas.height = H;
  }
  workCtx = work.getContext("2d", { willReadFrequently: true });
  overlayCtx = overlay.getContext("2d");
  visibleCtx = visible.getContext("2d");
  if (!workCtx || !overlayCtx || !visibleCtx) return;
  if (props.blank) {
    // 空白画布：透明底（保存 PNG 后引用处由文档底色透出），不垫白——垫白会破坏深色主题
    history.clear();
  } else if (sourceImage) {
    workCtx.drawImage(sourceImage, 0, 0, W, H);
  }
  ready.value = true;
  zoomController.fit();
  scheduleRender();
}

function loadImage(): void {
  ready.value = false;
  if (props.blank) {
    // 空白画布：src 只用来把组件挂上（key 变化触发重挂），尺寸走 prop
    W = Math.max(1, blankWidth);
    H = Math.max(1, blankHeight);
    sourceImage = null;
    initCanvases();
    return;
  }
  const img = new Image();
  img.onload = () => {
    // SVG 无内在尺寸时 WebKit 会给 0——兜一个可编辑的画幅
    W = Math.max(1, img.naturalWidth || img.width || 1024);
    H = Math.max(1, img.naturalHeight || img.height || 768);
    sourceImage = img;
    canvasSize.value = { width: W, height: H };
    history.clear();
    initCanvases();
  };
  img.onerror = () => emit("error", t("kb.imageDecodeFailed"));
  img.src = props.src;
}

watch(() => props.src, loadImage);

// ---- 渲染合成（rAF 节流）----
let raf = 0;
let erasingLive = false;

function render(): void {
  raf = 0;
  if (!visibleCtx || !work || !overlay) return;
  visibleCtx.clearRect(0, 0, W, H);
  visibleCtx.drawImage(work, 0, 0);
  if (erasingLive) {
    // 橡皮预览 = 从合成结果里抠掉笔画（与提交语义一致）
    visibleCtx.globalCompositeOperation = "destination-out";
    visibleCtx.drawImage(overlay, 0, 0);
    visibleCtx.globalCompositeOperation = "source-over";
  } else {
    visibleCtx.drawImage(overlay, 0, 0);
  }
}

function scheduleRender(): void {
  if (!raf) raf = requestAnimationFrame(render);
}

// ---- 指针交互 ----
let drawing = false;
let start: Pt = { x: 0, y: 0 };
let last: Pt = { x: 0, y: 0 };
let points: Pt[] = [];
/** 裁剪框（画布坐标）；crop 工具下拖拽产生，模板画虚线框。 */
const cropRect = ref<Rect | null>(null);
/** 裁剪是显式两段动作：框选后由头部按钮「应用/取消」收尾（避免抬起就切、误操作难撤）。 */
const cropping = ref(false);

function pointOf(event: PointerEvent): Pt {
  const rect = paperEl.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return toCanvasPoint(event.clientX, event.clientY, rect.left, rect.top, scale.value);
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  if ((event.target as HTMLElement)?.tagName === "TEXTAREA") return;
  if (textDraft.value) {
    commitTextDraft(); // 已有草稿 → 这次点击先提交（下一次点击再起新草稿）
    return;
  }
  const tool = drawSession.tool;
  const p = pointOf(event);
  start = last = p;
  points = [p];
  overlayCtx?.clearRect(0, 0, W, H);
  if (tool === "text") {
    openTextDraft(p);
    return;
  }
  if (tool === "crop") {
    cropRect.value = rectBetween(p, p, 0);
    cropping.value = true;
    paperEl.value?.setPointerCapture(event.pointerId);
    return;
  }
  if (tool === "fill") {
    applyFill(p);
    return;
  }
  drawing = true;
  erasingLive = tool === "eraser";
  paperEl.value?.setPointerCapture(event.pointerId);
  if (tool === "pencil" || tool === "eraser") drawFreehand(overlayCtx);
  else if (tool === "mosaic") previewMosaic(p, p);
  else drawShape(overlayCtx, p, p);
  scheduleRender();
}

function onPointerMove(event: PointerEvent): void {
  if (drawSession.tool === "crop" && cropping.value) {
    cropRect.value = rectBetween(start, pointOf(event), 0);
    return;
  }
  if (!drawing) return;
  const p = pointOf(event);
  last = p;
  points.push(p);
  if (drawSession.tool === "pencil" || drawSession.tool === "eraser") drawFreehand(overlayCtx);
  else if (drawSession.tool === "mosaic") previewMosaic(start, p);
  else drawShape(overlayCtx, start, p);
  scheduleRender();
}

function onPointerUp(): void {
  if (drawSession.tool === "crop" && cropping.value) {
    cropping.value = false;
    const rect = cropRect.value;
    // 太小的框（误点）当作取消
    if (!rect || rect.w < 4 || rect.h < 4) cropRect.value = null;
    return;
  }
  if (!drawing) return;
  drawing = false;
  erasingLive = false;
  commitStroke();
}

/** 油漆桶：整画布读像素 → 扫描线填充 → 全尺寸 patch 入栈。 */
function applyFill(at: Pt): void {
  if (!workCtx) return;
  const hex = drawSession.color.replace("#", "");
  const rgb: [number, number, number] = [
    parseInt(hex.slice(0, 2), 16) || 0,
    parseInt(hex.slice(2, 4), 16) || 0,
    parseInt(hex.slice(4, 6), 16) || 0,
  ];
  const before = workCtx.getImageData(0, 0, W, H);
  const rect = floodFill(before.data, W, H, at.x, at.y, rgb, FILL_TOLERANCE);
  if (!rect) {
    pushToast({ kind: "info", message: t("kb.drawFillNothing") }, 2200);
    return;
  }
  workCtx.putImageData(before, 0, 0); // floodFill 直接改了 before.data
  history.push({ x: 0, y: 0, w: W, h: H, before: before.data, after: workCtx.getImageData(0, 0, W, H).data });
  syncState();
  scheduleRender();
}

// ---- 裁剪 / 旋转 / 翻转（头部动作组调用）----
function applyCrop(): void {
  const rect = cropRect.value;
  if (!rect || !workCtx) return;
  const inner = clampRect(rect, W, H);
  const pixels = workCtx.getImageData(inner.x, inner.y, inner.w, inner.h);
  history.push({
    x: 0,
    y: 0,
    w: inner.w,
    h: inner.h,
    before: fullSnapshot(),
    after: pixels.data,
    cropFrom: { w: W, h: H },
  });
  cropRect.value = null;
  resizeCanvases(inner.w, inner.h, pixels);
}

function cancelCrop(): void {
  cropRect.value = null;
}

function rotate90(clockwise: boolean): void {
  if (!workCtx) return;
  const snapshot = workCtx.getImageData(0, 0, W, H);
  const nextW = H;
  const nextH = W;
  const rotated = new ImageData(nextW, nextH);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const src = (y * W + x) * 4;
      // 顺时针：新图 (W-1-y, x) = 旧图 (x, y)；逆时针：新图 (y, H-1-x)
      const nx = clockwise ? H - 1 - y : y;
      const ny = clockwise ? x : W - 1 - x;
      const dst = (ny * nextW + nx) * 4;
      for (let channel = 0; channel < 4; channel += 1) rotated.data[dst + channel] = snapshot.data[src + channel];
    }
  }
  history.push({
    x: 0,
    y: 0,
    w: nextW,
    h: nextH,
    before: snapshot.data,
    after: rotated.data,
    cropFrom: { w: W, h: H },
  });
  resizeCanvases(nextW, nextH, rotated);
}

function flip(axis: "h" | "v"): void {
  if (!workCtx) return;
  const snapshot = workCtx.getImageData(0, 0, W, H);
  const flipped = workCtx.createImageData(W, H);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const src = (y * W + x) * 4;
      const nx = axis === "h" ? W - 1 - x : x;
      const ny = axis === "h" ? y : H - 1 - y;
      const dst = (ny * W + nx) * 4;
      for (let channel = 0; channel < 4; channel += 1) flipped.data[dst + channel] = snapshot.data[src + channel];
    }
  }
  history.push({ x: 0, y: 0, w: W, h: H, before: snapshot.data, after: flipped.data });
  workCtx.putImageData(flipped, 0, 0);
  scheduleRender();
}

/** 尺寸变更专用：三张 canvas 重设、可见层换像素、重算 fit。 */
function resizeCanvases(width: number, height: number, initial: ImageData): void {
  W = width;
  H = height;
  canvasSize.value = { width: W, height: H };
  if (!workCtx || !overlayCtx) return;
  for (const canvas of [work, overlay, visibleRef.value]) {
    if (canvas) {
      canvas.width = W;
      canvas.height = H;
    }
  }
  workCtx.putImageData(initial, 0, 0);
  overlayCtx.clearRect(0, 0, W, H);
  zoomController.fit();
  syncState();
  scheduleRender();
}

function fullSnapshot(): Uint8ClampedArray {
  return workCtx ? workCtx.getImageData(0, 0, W, H).data : new Uint8ClampedArray(0);
}

function strokeRectFor(): Rect | null {
  const tool = drawSession.tool;
  if (tool === "pencil" || tool === "eraser") return strokeBBox(points, drawSession.width, W, H);
  if (tool === "mosaic") return clampRect(rectBetween(start, last, 1), W, H);
  return clampRect(rectBetween(start, last, drawSession.width / 2 + 2), W, H);
}

/** 提交一笔：before → 烘 overlay 进 work → after → patch 入栈。 */
function commitStroke(): void {
  if (!workCtx || !overlayCtx) return;
  const bbox = strokeRectFor();
  if (!bbox || bbox.w <= 0 || bbox.h <= 0) {
    overlayCtx.clearRect(0, 0, W, H);
    scheduleRender();
    return;
  }
  const before = workCtx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
  bakeOverlay();
  // ⚠️ 清 overlay 必须在 bake **之后**：先清再烘，烘进去的就是空画布
  // （症状 = 笔画有提交记录、撤销可用，但画面与导出永远不变——2026-09-19 用户实测踩中）
  overlayCtx.clearRect(0, 0, W, H);
  const after = workCtx.getImageData(bbox.x, bbox.y, bbox.w, bbox.h);
  history.push({ x: bbox.x, y: bbox.y, w: bbox.w, h: bbox.h, before: before.data, after: after.data });
  syncState();
  scheduleRender();
}

function bakeOverlay(): void {
  if (!workCtx || !overlay) return;
  if (drawSession.tool === "eraser") workCtx.globalCompositeOperation = "destination-out";
  workCtx.drawImage(overlay, 0, 0);
  workCtx.globalCompositeOperation = "source-over";
}

// ---- 各工具的 overlay 预览 ----
function applyStrokeStyle(ctx: CanvasRenderingContext2D): void {
  ctx.lineWidth = drawSession.width;
  ctx.strokeStyle = drawSession.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
}

function drawFreehand(ctx: CanvasRenderingContext2D | null): void {
  if (!ctx || points.length === 0) return;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  applyStrokeStyle(ctx);
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
  ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D | null, a: Pt, b: Pt): void {
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  applyStrokeStyle(ctx);
  const tool = drawSession.tool;
  ctx.beginPath();
  if (tool === "line") {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  } else if (tool === "arrow") {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    const head = Math.max(8, drawSession.width * ARROW_HEAD_RATIO);
    for (const point of arrowHead(a, b, head)) {
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(point.x, point.y);
    }
  } else if (tool === "rect") {
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
  } else if (tool === "ellipse") {
    ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
  }
  ctx.stroke();
  ctx.restore();
}

/** 像素化：src 的矩形区域缩成块再放大回 target（预览与提交共用同一条实现）。 */
function pixelateFrom(src: HTMLCanvasElement, target: CanvasRenderingContext2D, rect: Rect): void {
  const sw = Math.max(1, Math.round(rect.w / MOSAIC_BLOCK));
  const sh = Math.max(1, Math.round(rect.h / MOSAIC_BLOCK));
  const tmp = document.createElement("canvas");
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext("2d");
  if (!tctx) return;
  tctx.imageSmoothingEnabled = true; // 缩小时取块平均
  tctx.drawImage(src, rect.x, rect.y, rect.w, rect.h, 0, 0, sw, sh);
  target.save();
  target.imageSmoothingEnabled = false; // 放大回贴时保留马赛克块
  target.drawImage(tmp, 0, 0, sw, sh, rect.x, rect.y, rect.w, rect.h);
  target.restore();
}

function previewMosaic(a: Pt, b: Pt): void {
  if (!overlayCtx || !work) return;
  overlayCtx.clearRect(0, 0, W, H);
  const rect = clampRect(rectBetween(a, b, 0), W, H);
  if (rect.w <= 0 || rect.h <= 0) return;
  pixelateFrom(work, overlayCtx, rect);
}

// ---- 撤销 / 重做 ----
function undo(): void {
  const patch = history.undo();
  if (!patch || !workCtx) return;
  if (patch.cropFrom) {
    // 逆操作回到入口尺寸：先撑回旧画布，再贴 before（旧全图）
    resizeCanvases(patch.cropFrom.w, patch.cropFrom.h, new ImageData(patch.before, patch.w, patch.h));
    return;
  }
  workCtx.putImageData(new ImageData(patch.before, patch.w, patch.h), patch.x, patch.y);
  syncState();
  scheduleRender();
}

function redo(): void {
  const patch = history.redo();
  if (!patch || !workCtx) return;
  if (patch.cropFrom) {
    // 正向重放到出口尺寸：先缩到 (patch.w, patch.h)，再贴 after（新全图）
    resizeCanvases(patch.w, patch.h, new ImageData(patch.after, patch.w, patch.h));
    return;
  }
  workCtx.putImageData(new ImageData(patch.after, patch.w, patch.h), patch.x, patch.y);
  syncState();
  scheduleRender();
}

function syncState(): void {
  drawSession.canUndo = history.canUndo;
  drawSession.canRedo = history.canRedo;
  drawSession.dirty = history.canUndo;
}

// ---- 文字工具（DOM 浮层承接输入，保住输入法）----
function openTextDraft(at: Pt): void {
  textDraft.value = { x: at.x, y: at.y, value: "" };
  void nextTick(() => textEl.value?.focus());
}

function cancelTextDraft(): void {
  textDraft.value = null;
}

function commitTextDraft(): void {
  const draft = textDraft.value;
  if (!draft) return;
  textDraft.value = null;
  const lines = draft.value.replace(/\s+$/, "").split("\n");
  if (!workCtx || (lines.length === 1 && !lines[0])) return;
  drawTextLines(draft.x, draft.y, lines);
}

function textFont(): string {
  return `${drawSession.fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
}

function drawTextLines(x: number, y: number, lines: string[]): void {
  if (!workCtx) return;
  workCtx.save();
  workCtx.font = textFont();
  workCtx.textBaseline = "top";
  workCtx.fillStyle = drawSession.color;
  let maxLineWidth = 1;
  for (const line of lines) maxLineWidth = Math.max(maxLineWidth, workCtx.measureText(line).width);
  const box = clampRect(textBox(x, y, drawSession.fontSize, maxLineWidth, lines.length), W, H);
  if (box.w <= 0 || box.h <= 0) {
    workCtx.restore();
    return;
  }
  const before = workCtx.getImageData(box.x, box.y, box.w, box.h);
  const lineHeight = drawSession.fontSize * 1.35;
  lines.forEach((line, index) => workCtx?.fillText(line, x, y + index * lineHeight));
  const after = workCtx.getImageData(box.x, box.y, box.w, box.h);
  workCtx.restore();
  history.push({ x: box.x, y: box.y, w: box.w, h: box.h, before: before.data, after: after.data });
  syncState();
  scheduleRender();
}

function onTextKeydown(event: KeyboardEvent): void {
  event.stopPropagation(); // 别让 ⌘S/⌘Z/Esc 的全局处理打断组字
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    commitTextDraft();
  } else if (event.key === "Escape" && !event.isComposing) {
    cancelTextDraft();
  }
}

const textStyle = computed(() => {
  const draft = textDraft.value;
  if (!draft) return {};
  return {
    left: `${draft.x * scale.value}px`,
    top: `${draft.y * scale.value}px`,
    fontSize: `${drawSession.fontSize * scale.value}px`,
    color: drawSession.color,
  };
});

// ---- 导出 ----
function exportBlob(): Promise<Blob> {
  commitTextDraft();
  return new Promise((resolve, reject) => {
    if (!work) {
      reject(new Error("画布未就绪"));
      return;
    }
    work.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("导出图片失败"))), "image/png");
  });
}

defineExpose({ zoom, undo, redo, exportBlob, applyCrop, cancelCrop, rotate90, flip });

onMounted(() => {
  loadImage();
  resizeObserver = new ResizeObserver(() => zoomController.refit());
  if (stageEl.value) resizeObserver.observe(stageEl.value);
});

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  resizeObserver?.disconnect();
  resizeObserver = null;
  history.clear();
});
</script>

<template>
  <div class="draw-canvas">
    <div ref="stageEl" class="draw-stage" @wheel="onWheel">
      <div
        v-show="ready"
        ref="paperEl"
        class="draw-paper"
        :style="{ width: `${display.width}px`, height: `${display.height}px` }"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @contextmenu.prevent
      >
        <canvas
          ref="visibleRef"
          :width="canvasSize.width"
          :height="canvasSize.height"
          class="draw-visible"
          :class="drawSession.tool === 'text' ? 'is-text' : drawSession.tool === 'fill' ? 'is-fill' : 'is-cross'"
        />
        <!-- 裁剪框（画布坐标 × scale → 屏幕坐标）：虚线框 + 四周暗化由 outline 表达 -->
        <div
          v-if="cropRect"
          class="crop-box"
          :style="{
            left: `${cropRect.x * scale}px`,
            top: `${cropRect.y * scale}px`,
            width: `${cropRect.w * scale}px`,
            height: `${cropRect.h * scale}px`,
          }"
        />
        <textarea
          v-if="textDraft"
          ref="textEl"
          v-model="textDraft.value"
          class="draw-text-input"
          :style="textStyle"
          rows="1"
          :spellcheck="false"
          @keydown="onTextKeydown"
          @blur="commitTextDraft"
        />
      </div>
      <p v-if="!ready" class="draw-loading">{{ t("common.loading") }}</p>
    </div>
  </div>
</template>

<style scoped>
.draw-canvas {
  height: 100%;
  min-height: 0;
  outline: none;
}
.draw-stage {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: auto;
  background: var(--bg-app);
}
/* margin:auto：小图居中；大图撑开滚动（避开 flex 居中 + overflow 顶部裁切的经典坑） */
.draw-paper {
  position: relative;
  margin: auto;
  flex: none;
  background-image: linear-gradient(45deg, var(--bg-chip) 25%, transparent 25%, transparent 75%, var(--bg-chip) 75%),
    linear-gradient(45deg, var(--bg-chip) 25%, transparent 25%, transparent 75%, var(--bg-chip) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 8px 8px;
  box-shadow: 0 0 0 1px var(--border);
  touch-action: none; /* 指针绘图接管，别让系统手势抢事件 */
}
.draw-visible {
  display: block;
  width: 100%;
  height: 100%;
}
.draw-visible.is-cross {
  cursor: crosshair;
}
.draw-visible.cursor-fill,
.draw-visible.is-fill {
  cursor: cell;
}
.draw-visible.is-text {
  cursor: text;
}
.crop-box {
  position: absolute;
  border: 1px dashed var(--accent);
  outline: 9999px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
.draw-text-input {
  position: absolute;
  min-width: 48px;
  max-width: 90%;
  padding: 0 1px;
  border: 1px dashed var(--accent);
  background: transparent;
  outline: none;
  resize: none;
  overflow: hidden;
  white-space: pre;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
}
.draw-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-sm);
  color: var(--text-dim);
  margin: 0;
}
</style>
