// @vitest-environment jsdom
/**
 * CAD（DXF）解析的**真实图纸**验收。
 *
 * 背景：这份图纸（butterfly，CorelDRAW 导出）的 ENTITIES 段里**只有 44 条 SPLINE**，
 * 一条直线都没有。最早的解析器把 SPLINE 当作"复杂实体跳过"→ 打开就是一片空白，
 * 用户看到的"DXF 不行"就是这么来的。修好之后这里守两件事：
 * ① 真样条能被求值成折线（并且点不跑出控制凸包）；
 * ② 整张图的几何范围必须与**图纸自述的 `$EXTMIN/$EXTMAX`** 一致 ——
 *    这是不依赖"我觉得画对了"的客观判据（`tests/fixtures/dxf/` 里存了同源的真实样条）。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDxfEntities, sampleSpline, segmentsToSvg } from "../src/knowledge/preview/plugins/cad";

interface DxfPair {
  code: number;
  value: string;
}

function toPairs(bytes: Uint8Array): DxfPair[] {
  const lines = new TextDecoder("windows-1252").decode(bytes).split(/\r\n|\r|\n/);
  const pairs: DxfPair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10);
    if (!Number.isNaN(code)) pairs.push({ code, value: lines[i + 1] });
  }
  return pairs;
}

// jsdom 环境里 import.meta.url 不是 file:// 协议，用工作目录定位（vitest 的 cwd = 仓库根）
const FIXTURE = resolve(process.cwd(), "tests/fixtures/dxf/spline-sample.dxf");
/** 用户的真实图纸（不在仓库里；本机存在时跑完整验收，否则跳过）。 */
const REAL = "/Users/mrwang/Downloads/butterfly /butterfly .dxf";

describe("真实样条（fixture 取自 CorelDRAW 导出的图纸）", () => {
  const pairs = toPairs(new Uint8Array(readFileSync(FIXTURE)));
  const { segments, skipped } = parseDxfEntities(pairs);
  // 该实体的控制点范围（独立用 python 从原文件算出，见提交说明）
  const expected = { width: 1.14113, height: 1.079 };

  it("不再被当作「复杂实体」跳过", () => {
    expect(skipped).toBe(0);
    expect(segments.filter((s) => s.kind === "path").length).toBe(1);
  });

  it("求值成折线，且所有点都在控制点凸包内（B 样条的基本性质）", () => {
    const path = segments.find((s) => s.kind === "path")!;
    expect(path.points!.length, "采样点太少说明没有真求值").toBeGreaterThan(30);
    const xs = path.points!.map((p) => p[0]);
    const ys = path.points!.map((p) => p[1]);
    // 控制点 x ∈ [-5.478, -4.337]、y ∈ [-5.481, -4.402]
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-5.478 - 1e-3);
    expect(Math.max(...xs)).toBeLessThanOrEqual(-4.337 + 1e-3);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-5.481 - 1e-3);
    expect(Math.max(...ys)).toBeLessThanOrEqual(-4.402 + 1e-3);
  });

  it("几何范围落在控制点范围内，且没有只画出小半截", () => {
    const { box } = segmentsToSvg(segments, skipped);
    const width = box!.maxX - box!.minX;
    const height = box!.maxY - box!.minY;
    // B 样条曲线一定在控制多边形内 → 上界；下界是"别画丢了"的地板线
    expect(width).toBeGreaterThan(expected.width * 0.9);
    expect(width).toBeLessThanOrEqual(expected.width + 1e-6);
    expect(height).toBeGreaterThan(expected.height * 0.9);
    expect(height).toBeLessThanOrEqual(expected.height + 1e-6);
  });
});

describe("样条求值的可判定性质", () => {
  it("夹紧节点（两端重数 = 阶数）时首末点与控制点重合", () => {
    const control: [number, number][] = [
      [0, 0],
      [1, 3],
      [4, 3],
      [5, 0],
    ];
    // 4 个控制点 + 3 阶 → 节点数必须是 n+p+1 = 8；两端重数 4 = 夹紧（曲线过首末控制点）
    const knots = [0, 0, 0, 0, 1, 1, 1, 1];
    const pts = sampleSpline(control, 3, knots);
    expect(pts[0][0]).toBeCloseTo(0, 6);
    expect(pts[0][1]).toBeCloseTo(0, 6);
    expect(pts.at(-1)![0]).toBeCloseTo(5, 6);
    expect(pts.at(-1)![1]).toBeCloseTo(0, 6);
  });

  it("控制点共线 → 采样点也共线（阶数/参数传递不会引入抖动）", () => {
    const control: [number, number][] = [
      [0, 0],
      [1, 2],
      [3, 6],
      [4, 8],
    ];
    const pts = sampleSpline(control, 3, [0, 0, 0, 0, 1, 2, 2, 2]);
    for (const [x, y] of pts) expect(y).toBeCloseTo(x * 2, 6);
  });

  it("闭合样条首末点相同", () => {
    const control: [number, number][] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ];
    // 8 个节点的合法向量（同上），closed 标志决定是否把首点接回末尾
    const pts = sampleSpline(control, 3, [0, 0, 0, 0, 1, 2, 3, 3], undefined, true);
    expect(pts.at(-1)![0]).toBeCloseTo(pts[0][0], 6);
    expect(pts.at(-1)![1]).toBeCloseTo(pts[0][1], 6);
  });

  it("节点表不合法（导出器截断）→ 退化控制多边形，而不是画不出", () => {
    const control: [number, number][] = [
      [0, 0],
      [1, 1],
      [2, 0],
    ];
    const pts = sampleSpline(control, 3, [0, 1]);
    expect(pts).toEqual(control);
  });
});

describe.skipIf(!existsSync(REAL))("整张真实图纸（本机验收）", () => {
  it("44 条样条全部画出，范围与 $EXTMIN/$EXTMAX、兄弟 SVG 的 viewBox 一致", () => {
    const pairs = toPairs(new Uint8Array(readFileSync(REAL)));
    const { segments, skipped } = parseDxfEntities(pairs);
    const paths = segments.filter((s) => s.kind === "path");
    expect(paths.length).toBe(44);
    expect(skipped).toBe(0);

    const { box } = segmentsToSvg(segments, skipped);
    // 图纸自述：$EXTMIN(-12.05492,-12.13357) $EXTMAX(12.25021,12.22258)
    // 兄弟 SVG（CorelDRAW 导出）viewBox = 0 0 24302.5 24353.51 → 同一量级
    expect(box!.maxX - box!.minX).toBeCloseTo(24.305, 0);
    expect(box!.maxY - box!.minY).toBeCloseTo(24.356, 0);
  });
});

describe("范围计算的数字解析（真坑复现）", () => {
  it("指数写法不能被拆成两个数（`4.4e-16` 曾把 24.3 宽的图算成 26.3）", () => {
    const segments = [
      { kind: "path" as const, d: "M 4.4e-16 0 L 100 50" },
    ];
    const { box } = segmentsToSvg(segments, 0);
    expect(box!.minX).toBeCloseTo(0, 9);
    expect(box!.maxX).toBeCloseTo(100, 6);
    expect(box!.maxY).toBeCloseTo(50, 6);
  });

  it("带顶点数据的段不走字符串扫（圆弧的标志位不会被当坐标）", () => {
    const arc = {
      kind: "path" as const,
      d: "M 0 10 A 10 10 0 1 0 20 10",
      box: { minX: -0, minY: 0, maxX: 20, maxY: 20 },
    };
    const { box } = segmentsToSvg([arc], 0);
    expect(box!.minY).toBeCloseTo(0, 6);
    expect(box!.maxY).toBeCloseTo(20, 6);
  });
});

describe("尺寸契约：样式表必须显式给宽（WKWebView 的 0×0 陷阱）", () => {
  /**
   * 插件挂载时删掉了 SVG 自带的 width/height（图纸用户单位，26px 见方），尺寸只剩样式表这一处。
   * 而 WKWebView 会把「只有 viewBox、没有内在尺寸」的 SVG 在 flex 容器里算成 **0×0** ——
   * 图纸打开一片空白、信息行却照常写着「… · 44 个图元」（用户实测）；同机 Chromium 会撑满容器，
   * 所以只在浏览器里看是看不出来的。只写 `max-width: 100%` 不够，必须给 `width`。
   * jsdom 没有布局引擎，这里守的是**样式契约**这一层（真观感由实机 WKWebView 探针/截图确认）。
   */
  it("`.kb-cad-canvas svg` 规则里有显式 width", () => {
    const sfc = readFileSync(resolve(process.cwd(), "src/knowledge/KnowledgePreview.vue"), "utf8");
    const rule = /\.preview-host\s*:deep\(\.kb-cad-canvas svg\)\s*\{([^}]*)\}/.exec(sfc);
    expect(rule, "找不到 .kb-cad-canvas svg 样式规则").not.toBeNull();
    // 先去掉注释再断言：注释里提到过 "width:100%"，不去掉的话这条断言会被注释喂饱（假通过）
    const body = rule![1].replace(/\/\*[\s\S]*?\*\//g, "");
    expect(body, "只给 max-width 会被 WKWebView 算成 0×0").toMatch(/(^|\s)width:\s*100%/);
    expect(body).toMatch(/(^|\s)height:\s*auto/);
  });
});
