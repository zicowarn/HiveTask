/**
 * CAD 图纸预览（DXF / DWG）—— **静态矢量视图**，输出 SVG。
 *
 * 两条路径：
 * - **DXF**（文本格式）：自研解析 ENTITIES 段 → SVG。完全离线、无依赖；
 *   中文按图纸自己的 `$DWGCODEPAGE` 解码（ANSI_936 → gbk、950 → big5、932 → shift_jis…），
 *   另解 `\\U+XXXX` 转义与 `%%d/%%c/%%p` 符号 —— 这是中文图纸能不能看的前提；
 * - **DWG**（二进制）：`@mlightcad/libredwg-web` 的 wasm 解析成数据库，再由它的
 *   `dwg_to_svg` 出 SVG。wasm 随包放 `vendor/libredwg/`（9.5MB，**只在打开 DWG 时加载**）。
 *
 * 支持到"能看清一张真图"的程度：
 * - **SPLINE**（含 NURBS 权重，de Boor 求值）—— 真实图纸的曲线几乎全是它。corelDRAW /
 *   AutoCAD 导出的图形往往**一条直线都没有**，只画 LINE 的结果就是一片空白（踩过：
 *   那份 butterfly.dxf 的 ENTITIES 里是 44 条 SPLINE，别的什么都没有）；
 * - LINE / CIRCLE / ARC / ELLIPSE / LWPOLYLINE / POLYLINE / POINT / SOLID / TRACE / 3DFACE /
 *   TEXT / MTEXT / LEADER / INSERT（块引用展开一层）/ **DIMENSION**（跟着它的匿名块画）/
 *   **HATCH**（画边界，不还原填充图案）；
 * - 中文字面量按 `$DWGCODEPAGE` 解码 + `\U+XXXX` 转义还原。
 *
 * 明确不做的（如实标注，不假装）：
 * - 交互式 WebGL 视图（OFV 的 `cad-webgl`）：只读预览里 SVG 已能缩放看全图，
 *   引 three + WebGL 栈只为同一份几何再造一个渲染器，代价与收益不成比例；
 * - 三维实体（3DSOLID/REGION/BODY/MESH）、多线（MLINE）、属性文字（ATTDEF）不画（计入跳过数）；
 * - HATCH 的填充图案（剖面线）不还原，只画闭合边界；椭圆弧/样条边界按其端点近似；
 * - SHX 字体替换（文字用系统字体栈）。
 */
import type { PreviewContext, PreviewInstance, PreviewTool } from "../registry";
import { ZoomController, type Size } from "../zoom";

export const CAD_EXTENSIONS = ["dxf", "dwg"];
/** 认得出但本期不做的 CAD 交换格式：给诚实卡片，不装作能看。 */
export const CAD_UNSUPPORTED_EXTENSIONS = [
  "dwf",
  "step",
  "stp",
  "iges",
  "igs",
  "ifc",
  "sat",
  "sab",
  "x_t",
  "x_b",
  "3dm",
  "skp",
  "sldprt",
  "sldasm",
  "gds",
  "gdsii",
  "oas",
  "oasis",
];

/** 代码页 → TextDecoder 标签（DXF 里的 ANSI_936 就是 GBK）。 */
const CODEPAGE_LABELS: Record<string, string> = {
  "ansi_936": "gbk",
  "ansi_950": "big5",
  "ansi_932": "shift_jis",
  "ansi_949": "euc-kr",
  "ansi_1252": "windows-1252",
  "ansi_1251": "windows-1251",
  "ansi_874": "windows-874",
  "ansi_1250": "windows-1250",
  "ansi_1253": "windows-1253",
  "ansi_1254": "windows-1254",
  "ansi_1255": "windows-1255",
  "ansi_1256": "windows-1256",
  "ansi_1257": "windows-1257",
  "ansi_1258": "windows-1258",
  "utf8": "utf-8",
  "utf-8": "utf-8",
};

interface DxfPair {
  code: number;
  value: string;
}

/** 匹配一个完整数字（含指数写法）——别用 `-?\d+(\.\d+)?`，它会把 `1e-7` 拆成两个数。 */
const NUMBER_TOKEN = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface Segment {
  kind: "path" | "text";
  d?: string;
  /** 该路径的顶点（有它就算范围，别去正则扫 `d` —— 见下方 note）。 */
  points?: [number, number][];
  /** 圆/弧这类"点集不等于形状"的图元直接给包围盒。 */
  box?: Box;
  x?: number;
  y?: number;
  height?: number;
  rotation?: number;
  text?: string;
}

/** 整份文件按"两行一对"切成 (code, value)。 */
function toPairs(bytes: Uint8Array, decode: (b: Uint8Array) => string): DxfPair[] {
  const text = decode(bytes);
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: DxfPair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push({ code, value: lines[i + 1] });
  }
  return pairs;
}

/** 按图纸自己的代码页解码（先按 ASCII 找出 `$DWGCODEPAGE`，再整份解码）。 */
function decoderFor(bytes: Uint8Array): (b: Uint8Array) => string {
  const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const found = /\$DWGCODEPAGE[\s\S]{0,40}?ANSI_(\d{3,4})/i.exec(head);
  const label = found ? CODEPAGE_LABELS[`ansi_${found[1]}`] : undefined;
  if (label) {
    try {
      const decoder = new TextDecoder(label);
      return (b) => decoder.decode(b);
    } catch {
      /* 该 WebView 不认这个编码 → 退回 UTF-8 */
    }
  }
  try {
    return (b) => new TextDecoder("utf-8", { fatal: false }).decode(b);
  } catch {
    return (b) => new TextDecoder("windows-1252").decode(b);
  }
}

/** DXF 文本里的转义：`\U+XXXX`（中文常见）、MTEXT 的格式码、`%%d/%%c/%%p`。 */
export function decodeDxfText(raw: string): string {
  return raw
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/%%[dD]/g, "°")
    .replace(/%%[cC]/g, "Ø")
    .replace(/%%[pP]/g, "±")
    .replace(/\\P/gi, "\n")
    .replace(/\\[A-Za-z][^;\\]*;?/g, "") // MTEXT 的 \fArial|b0|i0; \H1.5x; 之类
    .replace(/[{}]/g, "");
}

function num(pairs: DxfPair[], start: number, end: number, code: number): number {
  for (let i = start; i < end; i += 1) if (pairs[i].code === code) return Number(pairs[i].value);
  return 0;
}

function str(pairs: DxfPair[], start: number, end: number, code: number): string {
  for (let i = start; i < end; i += 1) if (pairs[i].code === code) return pairs[i].value;
  return "";
}


/** 取某个组码在 [from,to) 内的**全部**取值（样条的 40/41/10 都是重复组码）。 */
function all(pairs: DxfPair[], start: number, end: number, code: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i += 1) if (pairs[i].code === code) out.push(Number(pairs[i].value));
  return out;
}

/** 成对的 x/y 取值（控制点 10/20、拟合点 11/21、多段线顶点）。 */
function pairValues(pairs: DxfPair[], start: number, end: number, xCode: number, yCode: number): [number, number][] {
  const out: [number, number][] = [];
  let pendingX: number | null = null;
  for (let i = start; i < end; i += 1) {
    const { code, value } = pairs[i];
    if (code === xCode) pendingX = Number(value);
    else if (code === yCode && pendingX !== null) {
      out.push([pendingX, Number(value)]);
      pendingX = null;
    }
  }
  return out;
}

/** 二分定位 u 所在的节点区间（Piegl & Tiller 的 findSpan）。 */
function findSpan(n: number, degree: number, u: number, knots: number[]): number {
  if (u >= knots[n + 1]) return n;
  if (u <= knots[degree]) return degree;
  let low = degree;
  let high = n + 1;
  let mid = (low + high) >> 1;
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) high = mid;
    else low = mid;
    mid = (low + high) >> 1;
  }
  return mid;
}

/**
 * B 样条求值（de Boor）→ 折线点。
 *
 * 真实图纸的曲线**几乎全是 SPLINE**（CorelDRAW / AutoCAD 导出都是这样），
 * 不支持它就等于画不出图 —— 实测那份 butterfly.dxf 的 ENTITIES 里只有 44 条 SPLINE，
 * 一条直线都没有，所以"跳过 SPLINE"的表现就是一片空白。
 *
 * 有 41 权重时按 NURBS 处理（齐次坐标求值后除掉权重）。
 */
export function sampleSpline(
  control: [number, number][],
  degree: number,
  knots: number[],
  weights?: number[],
  closed = false,
  samplesPerSpan = 10,
): [number, number][] {
  if (control.length < 2) return control;
  const p = Math.max(1, Math.min(degree, control.length - 1));
  const need = control.length + p + 1;
  // 节点表不合法（有些导出器会截断）→ 退化成控制多边形，至少画出个形状
  if (knots.length < need) return closed ? [...control, control[0]] : control;

  const n = control.length - 1;
  const rational = !!weights && weights.length === control.length && weights.some((w) => w !== 1);
  const pts = control.map(([x, y], i) => {
    const w = rational ? (weights![i] || 1) : 1;
    return { x: x * w, y: y * w, w };
  });

  const uStart = knots[p];
  const uEnd = knots[n + 1];
  const spans = Math.max(1, n + 1 - p);
  const steps = Math.max(24, spans * samplesPerSpan);
  const out: [number, number][] = [];

  const evalAt = (u: number): [number, number] => {
    const k = findSpan(n, p, u, knots);
    const d = [];
    for (let j = 0; j <= p; j += 1) d[j] = { ...pts[k - p + j] };
    for (let r = 1; r <= p; r += 1) {
      for (let j = p; j >= r; j -= 1) {
        const denom = knots[k + 1 + j - r] - knots[k - p + j];
        const alpha = denom === 0 ? 0 : (u - knots[k - p + j]) / denom;
        d[j] = {
          x: (1 - alpha) * d[j - 1].x + alpha * d[j].x,
          y: (1 - alpha) * d[j - 1].y + alpha * d[j].y,
          w: (1 - alpha) * d[j - 1].w + alpha * d[j].w,
        };
      }
    }
    const last = d[p];
    const w = last.w || 1;
    return [last.x / w, last.y / w];
  };

  for (let i = 0; i <= steps; i += 1) {
    const u = uStart + ((uEnd - uStart) * i) / steps;
    out.push(evalAt(Math.min(u, uEnd)));
  }
  if (closed) out.push(out[0]);
  return out;
}

/**
 * HATCH 的边界路径 → 点集数组（每条边界一个闭环点集）。
 *
 * 只解**够用的部分**：多段线边界（92 位 2）与直线/圆弧边（72 = 1/2）。
 * 椭圆弧边与样条边（72 = 3/4）跳过 —— 它们出现在少见的填充里，
 * 代价是把"这条边界画不出来"计入跳过数，而不是默默少画。
 */
function hatchBoundary(pairs: DxfPair[], start: number, end: number): [number, number][][] {
  const paths: [number, number][][] = [];
  let i = start + 1;
  while (i < end) {
    if (pairs[i].code !== 92) {
      i += 1;
      continue;
    }
    const flag = Number(pairs[i].value);
    const countIdx = pairs.findIndex((pair, idx) => idx > i && idx < end && pair.code === 93);
    if (countIdx < 0) break;
    const count = Number(pairs[countIdx].value);
    let j = countIdx + 1;
    // 多段线边界：顶点是 10/20（带 42 凸度，这里按直线连）
    if ((flag & 2) === 2) {
      const vertices: [number, number][] = [];
      while (j < end && pairs[j].code !== 92) {
        if (pairs[j].code === 10) {
          const yIdx = pairs.findIndex((pair, idx) => idx > j && idx < end && pair.code === 20);
          if (yIdx > 0) vertices.push([Number(pairs[j].value), Number(pairs[yIdx].value)]);
          j = yIdx > 0 ? yIdx : j;
        }
        j += 1;
      }
      if (vertices.length > 2) paths.push(vertices);
      i = j;
      continue;
    }
    // 边序列：每条边以 72 开头
    const points: [number, number][] = [];
    let used = 0;
    while (j < end && used < count) {
      if (pairs[j].code !== 72) {
        j += 1;
        continue;
      }
      const type = Number(pairs[j].value);
      const edgeEnd = (() => {
        for (let k = j + 1; k < end; k += 1) if (pairs[k].code === 72 || pairs[k].code === 92 || pairs[k].code === 97) return k;
        return end;
      })();
      const sx = num(pairs, j, edgeEnd, 10);
      const sy = num(pairs, j, edgeEnd, 20);
      const ex = num(pairs, j, edgeEnd, 11);
      const ey = num(pairs, j, edgeEnd, 21);
      if (type === 1) {
        points.push([sx, sy], [ex, ey]);
      } else if (type === 2) {
        // 圆弧边：中心 10/20、半径 40、起止角 50/51
        const cx = sx;
        const cy = sy;
        const radius = num(pairs, j, edgeEnd, 40);
        const a0 = num(pairs, j, edgeEnd, 50);
        const a1 = num(pairs, j, edgeEnd, 51);
        const a2 = num(pairs, j, edgeEnd, 73) || 1;
        for (let step = 0; step <= 12; step += 1) {
          const angle = a0 + ((a1 - a0) * step) / 12 / a2;
          points.push(polar(cx, cy, radius, angle));
        }
      } else {
        // 椭圆弧/样条边：跳过（由调用方计入"简化"）
        points.push([sx, sy], [ex, ey]);
      }
      used += 1;
      j = edgeEnd;
    }
    if (points.length > 2) paths.push(points);
    i = j;
  }
  return paths;
}

/**
 * 坐标输出的定点精度。
 * 不裁这一步，样条求值出来的 `4.4e-16` 这类值会以指数写法进 SVG ——
 * 路径本身仍然合法，但**按数字扫范围的旧实现会把 "4.4e-16" 读成 4 和 -16**，
 * 于是一张 24.3 宽的图被算成 26.3（真实坑，见 tests/kb-preview-cad-real.test.ts）。
 */
function round(value: number): string {
  const fixed = value.toFixed(3);
  return fixed === "-0.000" ? "0.000" : fixed.replace(/\.?0+$/, "") || "0";
}

function pathOf(points: [number, number][], close = false): string {
  if (points.length < 2) return "";
  const seq = close ? [...points, points[0]] : points;
  return `M ${seq.map(([x, y]) => `${round(x)} ${round(y)}`).join(" L ")}`;
}

/** 圆/弧的包围盒（圆弧用整圆的外接框，偏保守但不会漏）。 */
function circleBox(cx: number, cy: number, r: number): Box {
  return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** ENTITIES → 线段集合（只取能画的，其余由调用方计入 "跳过" 计数）。 */
export function parseDxfEntities(pairs: DxfPair[]): { segments: Segment[]; skipped: number } {
  const segments: Segment[] = [];
  let skipped = 0;

  // 先建块表：INSERT 时按块名展开一层
  const blocks = new Map<string, Segment[]>();
  const bounds: { start: number; end: number }[] = [];
  for (let i = 0; i < pairs.length; i += 1) {
    if (pairs[i].code === 0 && pairs[i].value.trim() === "SECTION") {
      const name = pairs[i + 1]?.value?.trim();
      if (name === "ENTITIES" || name === "BLOCKS") bounds.push({ start: i + 2, end: pairs.length });
    }
  }

  const spanOf = (start: number): number => {
    for (let i = start; i < pairs.length; i += 1) {
      if (pairs[i].code === 0 && pairs[i].value.trim() === "ENDSEC") return i;
    }
    return pairs.length;
  };

  const parseRange = (from: number, to: number, into: Segment[]): void => {
    let i = from;
    let currentBlock: Segment[] | null = null;
    let polyVertices: [number, number][] = [];
    let polyClosed = false;
    let polyKind = "";

    const flushPoly = (): void => {
      const sink = currentBlock ?? into;
      if (polyVertices.length > 1) {
        const pts = polyClosed ? [...polyVertices, polyVertices[0]] : polyVertices;
        sink.push({ kind: "path", d: `M ${pts.map(([x, y]) => `${x} ${y}`).join(" L ")}` });
      }
      polyVertices = [];
      polyClosed = false;
    };

    const entityEnd = (start: number): number => {
      for (let j = start + 1; j < to; j += 1) if (pairs[j].code === 0) return j;
      return to;
    };

    while (i < to) {
      if (pairs[i].code !== 0) {
        i += 1;
        continue;
      }
      const type = pairs[i].value.trim().toUpperCase();
      const end = entityEnd(i);
      const sink = currentBlock ?? into;

      if (polyKind && type !== "VERTEX" && type !== "SEQEND") flushPoly();

      switch (type) {
        case "SECTION":
          i = spanOf(i + 1);
          break;
        case "BLOCK": {
          const name = str(pairs, i, end, 2).trim();
          currentBlock = name ? (blocks.get(name) ?? []) : [];
          if (name && !blocks.has(name)) blocks.set(name, currentBlock);
          break;
        }
        case "ENDBLK":
          currentBlock = null;
          break;
        case "LINE": {
          const x1 = num(pairs, i, end, 10);
          const y1 = num(pairs, i, end, 20);
          const x2 = num(pairs, i, end, 11);
          const y2 = num(pairs, i, end, 21);
          sink.push({ kind: "path", d: pathOf([[x1, y1], [x2, y2]]), points: [[x1, y1], [x2, y2]] });
          break;
        }
        case "CIRCLE": {
          const cx = num(pairs, i, end, 10);
          const cy = num(pairs, i, end, 20);
          const r = num(pairs, i, end, 40);
          sink.push({
            kind: "path",
            d: `M ${round(cx - r)} ${round(cy)} A ${round(r)} ${round(r)} 0 1 0 ${round(cx + r)} ${round(cy)} A ${round(r)} ${round(r)} 0 1 0 ${round(cx - r)} ${round(cy)}`,
            box: circleBox(cx, cy, r),
          });
          break;
        }
        case "ARC": {
          const cx = num(pairs, i, end, 10);
          const cy = num(pairs, i, end, 20);
          const r = num(pairs, i, end, 40);
          const a0 = num(pairs, i, end, 50);
          const a1 = num(pairs, i, end, 51);
          const [sx, sy] = polar(cx, cy, r, a0);
          const [ex, ey] = polar(cx, cy, r, a1);
          const large = Math.abs(((a1 - a0 + 360) % 360)) > 180 ? 1 : 0;
          sink.push({ kind: "path", d: `M ${round(sx)} ${round(sy)} A ${round(r)} ${round(r)} 0 ${large} 0 ${round(ex)} ${round(ey)}`, box: circleBox(cx, cy, r) });
          break;
        }
        case "ELLIPSE": {
          const cx = num(pairs, i, end, 10);
          const cy = num(pairs, i, end, 20);
          const mx = num(pairs, i, end, 11);
          const my = num(pairs, i, end, 21);
          const ratio = num(pairs, i, end, 40) || 1;
          const major = Math.hypot(mx, my);
          const minor = major * ratio;
          const rot = (Math.atan2(my, mx) * 180) / Math.PI;
          sink.push({
            kind: "path",
            d: `M ${round(cx - major)} ${round(cy)} A ${round(major)} ${round(minor)} ${round(rot)} 1 0 ${round(cx + major)} ${round(cy)} A ${round(major)} ${round(minor)} ${round(rot)} 1 0 ${round(cx - major)} ${round(cy)}`,
            box: circleBox(cx, cy, Math.max(major, minor)),
          });
          break;
        }
        case "LWPOLYLINE": {
          const closed = (num(pairs, i, end, 70) & 1) === 1;
          const pts: [number, number][] = [];
          for (let j = i; j < end; j += 1) {
            if (pairs[j].code === 10 && pairs[j + 1]?.code === 20) {
              pts.push([Number(pairs[j].value), Number(pairs[j + 1].value)]);
            }
          }
          if (pts.length > 1) sink.push({ kind: "path", d: pathOf(pts, closed), points: pts });
          break;
        }
        case "POLYLINE":
          polyKind = "polyline";
          polyClosed = (num(pairs, i, end, 70) & 1) === 1;
          polyVertices = [];
          break;
        case "VERTEX":
          polyVertices.push([num(pairs, i, end, 10), num(pairs, i, end, 20)]);
          break;
        case "SEQEND":
          flushPoly();
          polyKind = "";
          break;
        case "TEXT":
        case "MTEXT": {
          const raw = str(pairs, i, end, 1);
          const text = decodeDxfText(raw).trim();
          if (!text) break;
          sink.push({
            kind: "text",
            x: num(pairs, i, end, 10),
            y: num(pairs, i, end, 20),
            height: num(pairs, i, end, 40) || 2.5,
            rotation: num(pairs, i, end, 50),
            text,
          });
          break;
        }
        case "SPLINE": {
          const fitPoints = pairValues(pairs, i, end, 11, 21);
          const controlPoints = pairValues(pairs, i, end, 10, 20);
          const flags = num(pairs, i, end, 70);
          const closed = (flags & 1) === 1;
          const degree = num(pairs, i, end, 71) || 3;
          const knots = all(pairs, i, end, 40);
          const weights = all(pairs, i, end, 41);
          // 有拟合点就按拟合点连线（导出器给的才是原始曲线通过的点）
          const points = fitPoints.length > 1
            ? (closed ? [...fitPoints, fitPoints[0]] : fitPoints)
            : sampleSpline(controlPoints, degree, knots, weights.length ? weights : undefined, closed);
          const d = pathOf(points);
          if (d) sink.push({ kind: "path", d, points });
          else skipped += 1;
          break;
        }
        case "LEADER": {
          // 引线：顶点序列就是折线（不画箭头，预览里看得懂即可）
          const points = pairValues(pairs, i, end, 10, 20);
          const d = pathOf(points);
          if (d) sink.push({ kind: "path", d, points });
          else skipped += 1;
          break;
        }
        case "SOLID":
        case "TRACE":
        case "3DFACE": {
          // 三/四点填充块：按轮廓画闭合路径（填充图案不还原）
          const corners = pairValues(pairs, i, end, 10, 20);
          const extra = pairValues(pairs, i, end, 13, 23);
          const points = [...corners, ...extra];
          const d = pathOf(points, true);
          if (d) sink.push({ kind: "path", d, points });
          else skipped += 1;
          break;
        }
        case "POINT": {
          const x = num(pairs, i, end, 10);
          const y = num(pairs, i, end, 20);
          const r = 0.5;
          sink.push({ kind: "path", d: `M ${round(x - r)} ${round(y)} L ${round(x + r)} ${round(y)} M ${round(x)} ${round(y - r)} L ${round(x)} ${round(y + r)}`, box: circleBox(x, y, r) });
          break;
        }
        case "HATCH": {
          // 填充：只画边界（图案填充本身不还原），墙/柱这类剖面在预览里就不至于消失
          const edges = hatchBoundary(pairs, i, end);
          let drawn = 0;
          for (const edge of edges) {
            const d = pathOf(edge, true);
            if (d) {
              sink.push({ kind: "path", d, points: edge });
              drawn += 1;
            }
          }
          if (drawn === 0) skipped += 1;
          break;
        }
        case "INSERT":
        case "DIMENSION": {
          // 标注的图形藏在匿名块里（*D1 这类），跟着块引用画出来
          const name = str(pairs, i, end, 2).trim();
          const block = blocks.get(name);
          if (!block) {
            skipped += 1;
            break;
          }
          const dx = num(pairs, i, end, 10);
          const dy = num(pairs, i, end, 20);
          for (const segment of block) {
            if (segment.kind === "text") {
              sink.push({ ...segment, x: (segment.x ?? 0) + dx, y: (segment.y ?? 0) + dy });
              continue;
            }
            // 有顶点就按顶点平移后重算 d（对字符串做正则平移会把数字改坏）
            if (segment.points) {
              const moved = segment.points.map(([x, y]): [number, number] => [x + dx, y + dy]);
              sink.push({ kind: "path", d: pathOf(moved), points: moved });
            } else if (segment.box) {
              sink.push({
                kind: "path",
                d: segment.d,
                box: {
                  minX: segment.box.minX + dx,
                  minY: segment.box.minY + dy,
                  maxX: segment.box.maxX + dx,
                  maxY: segment.box.maxY + dy,
                },
              });
            }
          }
          break;
        }
        case "ATTDEF":
        case "MLINE":
        case "REGION":
        case "BODY":
        case "MESH":
          // 属性定义（随块引用展开才有意义）、多线、三维实体：不画，计入跳过数
          skipped += 1;
          break;
        default:
          break;
      }
      i = end;
    }
    flushPoly();
  };

  // 顺序不能反：先把 BLOCKS 段里的块定义读进 map，ENTITIES 里的 INSERT 才展开得出来
  const sectionOf = (name: string): { start: number; end: number } | undefined =>
    bounds.find((b) => b.start > 0 && pairs[b.start - 1]?.value?.trim() === name);
  const blocksSection = sectionOf("BLOCKS");
  if (blocksSection) parseRange(blocksSection.start, spanOf(blocksSection.start), []);
  const entities = sectionOf("ENTITIES");
  if (entities) parseRange(entities.start, spanOf(entities.start), segments);
  return { segments, skipped };
}

/** 线段集合 → SVG（DXF 的 Y 轴向上，SVG 向下，这里翻一次）。 */
export function segmentsToSvg(
  segments: Segment[],
  skipped: number,
): { svg: string; width: number; height: number; box: Box | null } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consider = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const segment of segments) {
    if (segment.kind === "text") {
      consider(segment.x ?? 0, segment.y ?? 0);
      consider((segment.x ?? 0) + (segment.text?.length ?? 0) * (segment.height ?? 2.5) * 0.6, (segment.y ?? 0) + (segment.height ?? 2.5));
    } else if (segment.points) {
      // 首选：直接用顶点数据（精确，且不受字符串格式影响）
      for (const [x, y] of segment.points) consider(x, y);
    } else if (segment.box) {
      consider(segment.box.minX, segment.box.minY);
      consider(segment.box.maxX, segment.box.maxY);
    } else if (segment.d) {
      // 兜底：只有 d 字符串时按数字扫（仅直线段安全 —— 圆弧里的
      // rotation/large-arc/sweep 标志会被当成坐标，所以圆弧一律带 box）。
      // 这个正则必须**整体吞掉指数写法**：`4.4e-16` 若被拆成 4 和 -16，
      // 一张 24.3 宽的图会被算成 26.3（踩过）。
      const numbers = segment.d.match(NUMBER_TOKEN) ?? [];
      for (let i = 0; i + 1 < numbers.length; i += 2) consider(Number(numbers[i]), Number(numbers[i + 1]));
    }
  }
  if (!Number.isFinite(minX)) {
    return { svg: "", width: 0, height: 0, box: null };
  }
  // 原始几何范围（不含画布留白）—— 验收要用它跟图纸自述的 $EXTMIN/$EXTMAX 比
  const box: Box = { minX, minY, maxX, maxY };
  const pad = Math.max((maxX - minX) * 0.03, 1);
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const width = maxX - minX;
  const height = maxY - minY;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(2)} ${height.toFixed(2)}" width="${width.toFixed(2)}" height="${height.toFixed(2)}">`,
    `<g transform="translate(${(-minX).toFixed(2)} ${maxY.toFixed(2)}) scale(1 -1)" fill="none" stroke="currentColor" stroke-width="${(Math.max(width, height) / 900).toFixed(4)}">`,
  ];
  for (const segment of segments) {
    if (segment.kind !== "path" || !segment.d) continue;
    parts.push(`<path d="${segment.d}" />`);
  }
  parts.push("</g>");
  for (const segment of segments) {
    if (segment.kind !== "text" || !segment.text) continue;
    const size = segment.height ?? 2.5;
    const rotate = segment.rotation ? ` transform="rotate(${-segment.rotation} ${segment.x} ${maxY - (segment.y ?? 0)})"` : "";
    parts.push(
      `<text x="${segment.x}" y="${(maxY - (segment.y ?? 0) - size).toFixed(2)}" font-size="${size}" fill="currentColor"${rotate}>${escapeXml(segment.text)}</text>`,
    );
  }
  parts.push("</svg>");
  if (skipped > 0) {
    // 不静默：把跳过的东西写进 SVG 之外的信息行（见 renderCad 的 meta）
  }
  return { svg: parts.join(""), width, height, box };
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);
}

async function renderCad(ctx: PreviewContext): Promise<PreviewInstance> {
  const bytes = await ctx.readBytes();
  const wrap = document.createElement("div");
  wrap.className = "kb-cad";
  const bar = document.createElement("p");
  bar.className = "kb-cad-bar";
  const canvas = document.createElement("div");
  canvas.className = "kb-cad-canvas";
  wrap.append(bar, canvas);
  ctx.container.replaceChildren(wrap);

  let svg = "";
  let info = "";
  let skippedNote = "";
  let naturalBox: Size = { width: 0, height: 0 };

  if (ctx.ext === "dxf") {
    const head = new TextDecoder("windows-1252").decode(bytes.subarray(0, 32));
    if (head.startsWith("AutoCAD Binary DXF")) {
      bar.textContent = "二进制 DXF 不支持（请用默认应用打开，或另存为 ASCII DXF）";
      return {};
    }
    const pairs = toPairs(bytes, decoderFor(bytes));
    const { segments, skipped } = parseDxfEntities(pairs);
    const built = segmentsToSvg(segments, skipped);
    svg = built.svg;
    naturalBox = { width: built.width, height: built.height };
    info = `${segments.filter((s) => s.kind === "path").length} 个图元`;
    skippedNote = skipped ? ` · ${skipped} 个复杂实体（填充/标注/样条）未绘制` : "";
  } else {
    // DWG：wasm 解析 → SVG（wasm 只在第一次打开 DWG 时下载并缓存实例）
    const { LibreDwg } = await import("@mlightcad/libredwg-web");
    const libredwg = await LibreDwg.create("/vendor/libredwg");
    const fileContent = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const data = libredwg.dwg_read_data(fileContent, 0);
    if (!data) throw new Error("DWG 解析失败（文件损坏或加密）");
    try {
      const converted = libredwg.convertEx(data);
      svg = libredwg.dwg_to_svg(converted.database);
      const viewBox = /viewBox="([\d.\-\s]+)"/.exec(svg)?.[1]?.trim().split(/\s+/).map(Number);
      if (viewBox?.length === 4) naturalBox = { width: viewBox[2], height: viewBox[3] };
      info = `DWG → SVG（libredwg wasm）`;
    } finally {
      libredwg.dwg_free(data);
    }
  }

  if (!svg) {
    bar.textContent = "图纸里没有可绘制的图元";
    return {};
  }
  // SVG 来自本地解析/本库生成，仍按不可信输入处理：去脚本后再挂载
  const { default: DOMPurify } = await import("dompurify");
  canvas.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  const svgEl = canvas.querySelector("svg");
  if (svgEl) {
    // 尺寸由**内联样式**给（见下面 apply）：属性会被样式表里的 `.kb-cad-canvas svg { width:100% }`
    // 盖掉 —— 之前把 width/height 属性当缩放出口，结果"点了放大没反应"（用户实测）。
    // 保留那条 100% 规则是为了 WKWebView（只带 viewBox 的 SVG 在 flex 里会被算成 0×0），
    // 内联样式优先级更高，两者不冲突。
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");
    svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
  }
  bar.textContent = `${ctx.name} · ${info}${skippedNote}`;

  // ---- 缩放：矢量图按内联 width 重排（不是 transform，放大不糊）----
  // 百分比以"适应窗口"为 100%（见 zoom.ts 的 ZoomController 注释）
  const controller = new ZoomController({
    content: () => naturalBox,
    viewport: (): Size => {
      const rect = canvas.getBoundingClientRect();
      // 减去画布自身的内边距（14px × 2），否则"适应"会溢出一点点
      return { width: Math.max(0, rect.width - 28), height: Math.max(0, rect.height - 28) };
    },
    apply: (scale) => {
      if (!svgEl) return;
      svgEl.style.width = `${Math.round(naturalBox.width * scale)}px`;
      svgEl.style.height = `${Math.round(naturalBox.height * scale)}px`;
    },
    report: (state) => ctx.onZoom?.(state),
  });

  // 初次进入按"适应窗口"（= 100%）
  controller.fit();
  const observer = new ResizeObserver(() => controller.refit());
  observer.observe(canvas);

  return {
    destroy() {
      observer.disconnect();
    },
    zoom(action) {
      if (action === "fit") controller.fit();
      else if (action === "fit-width") controller.fit("width");
      else if (action === "fit-page") controller.fit("page");
      else controller.step(action);
    },
  };
}

/** DWG 文件头 = `AC10xx`（AC1015=R2000、AC1032=R2018…），文本 DXF 不是这样。 */
export function looksLikeDwg(head: Uint8Array): boolean {
  if (head.length < 6) return false;
  return /^AC10\d\d$/.test(new TextDecoder("windows-1252").decode(head.subarray(0, 6)));
}

export const cadPlugin = {
  id: "cad",
  extensions: CAD_EXTENSIONS,
  tools: ["zoom"] satisfies PreviewTool[],
  // 只用于 magic 通道（无扩展名/改名的 DWG）；`.dxf` 走扩展名通道，不做头字节要求
  matchHead: (head: Uint8Array) => looksLikeDwg(head),
  render: renderCad,
};
