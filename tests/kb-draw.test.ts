/**
 * 绘图模块纯逻辑：几何换算 / 撤销栈字节预算 / 另存命名 / 会话复位。
 * 画布交互（指针/合成）与保存链路需要真机，不在本组。
 */
import { describe, expect, it } from "vitest";
import {
  arrowHead,
  clampRect,
  rectBetween,
  strokeBBox,
  textBox,
  toCanvasPoint,
  unionRect,
} from "../src/knowledge/draw/geometry";
import { EditHistory, type Patch } from "../src/knowledge/draw/history";
import { floodFill } from "../src/knowledge/draw/fill";
import { BLANK_CANVAS_SIZE, createDrawSession, DRAW_TOOLS, resetDrawSession } from "../src/knowledge/draw/session";
import { drawnFileName, drawnRelPath, editedFileName, editedRelPath } from "../src/knowledge/editor/assets";

function patch(id: number, pixels = 4): Patch {
  return { x: id, y: 0, w: 1, h: 1, before: new Uint8ClampedArray(pixels), after: new Uint8ClampedArray(pixels) };
}

describe("坐标换算", () => {
  it("屏幕 → 画布随 scale 换算（含平移）", () => {
    // paper 左上在屏幕 (100, 50)，显示比例 0.5
    expect(toCanvasPoint(150, 100, 100, 50, 0.5)).toEqual({ x: 100, y: 100 });
    expect(toCanvasPoint(110, 60, 100, 50, 2)).toEqual({ x: 5, y: 5 });
  });

  it("scale 非法（0/负）按 1 处理，不产生 Infinity", () => {
    expect(toCanvasPoint(120, 80, 100, 50, 0)).toEqual({ x: 20, y: 30 });
  });
});

describe("矩形几何", () => {
  it("负向拖拽归正 + pad 外扩", () => {
    expect(rectBetween({ x: 100, y: 50 }, { x: 40, y: 10 }, 2)).toEqual({ x: 38, y: 8, w: 64, h: 44 });
  });

  it("并集覆盖两矩形的外包", () => {
    expect(unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toEqual({ x: 0, y: 0, w: 15, h: 15 });
    expect(unionRect(null, { x: 3, y: 4, w: 5, h: 6 })).toEqual({ x: 3, y: 4, w: 5, h: 6 });
  });

  it("夹回画布：出界裁掉、取整", () => {
    expect(clampRect({ x: -5.5, y: 2, w: 20, h: 4 }, 100, 100)).toEqual({ x: 0, y: 2, w: 15, h: 4 });
    expect(clampRect({ x: 90, y: 90, w: 50, h: 50 }, 100, 100)).toEqual({ x: 90, y: 90, w: 10, h: 10 });
  });
});

describe("笔画脏矩形", () => {
  it("点集包围盒 + 线宽一半外扩 + 1px 余量", () => {
    const box = strokeBBox([{ x: 10, y: 10 }, { x: 20, y: 16 }], 4, 1000, 1000);
    expect(box).toEqual({ x: 7, y: 7, w: 16, h: 12 });
  });

  it("贴边笔画夹回画布；空点集为 null", () => {
    // pad = 4/2+1 = 3：包围盒 (-3,-3,6,6) 夹回后取整 → {0,0,3,3}
    expect(strokeBBox([{ x: 0, y: 0 }], 4, 100, 100)).toEqual({ x: 0, y: 0, w: 3, h: 3 });
    expect(strokeBBox([], 4, 100, 100)).toBeNull();
  });
});

describe("箭头头部", () => {
  it("两条短线从尖端向起点方向张开", () => {
    const [a, b] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 12);
    // 尖端在 (100, 0)，头部点在尖端后方（x < 100），上下对称
    expect(a.x).toBeLessThan(100);
    expect(b.x).toBeLessThan(100);
    expect(a.y).toBeGreaterThan(0);
    expect(b.y).toBeLessThan(0);
    expect(a.y).toBeCloseTo(-b.y, 5);
  });
});

describe("文字块脏矩形", () => {
  it("按行高 1.35 倍累计，宽度取测量最大值", () => {
    const box = textBox(10, 20, 24, 100, 2);
    expect(box.x).toBe(10);
    expect(box.y).toBe(20);
    expect(box.w).toBe(100);
    expect(box.h).toBeCloseTo(64.8, 5);
  });
});

describe("撤销栈", () => {
  it("push → undo → redo 往返，内容对位", () => {
    const history = new EditHistory();
    history.push(patch(1));
    history.push(patch(2));
    expect(history.canUndo).toBe(true);
    expect(history.undo()).toMatchObject({ x: 2 });
    expect(history.canRedo).toBe(true);
    expect(history.undo()).toMatchObject({ x: 1 });
    expect(history.canUndo).toBe(false);
    expect(history.redo()).toMatchObject({ x: 1 });
    expect(history.redo()).toMatchObject({ x: 2 });
    expect(history.canRedo).toBe(false);
  });

  it("新笔画使 redo 失效", () => {
    const history = new EditHistory();
    history.push(patch(1));
    history.undo();
    expect(history.canRedo).toBe(true);
    history.push(patch(2));
    expect(history.canRedo).toBe(false);
    expect(history.undo()).toMatchObject({ x: 2 });
  });

  it("按字节预算淘汰最旧步骤，但至少保留最后一步", () => {
    // 预算 24 字节：每步 8 字节 → 最多留 3 步
    const history = new EditHistory(24);
    for (let i = 0; i < 6; i += 1) history.push(patch(i));
    expect(history.undo()).toMatchObject({ x: 5 });
    expect(history.undo()).toMatchObject({ x: 4 });
    expect(history.undo()).toMatchObject({ x: 3 });
    expect(history.canUndo).toBe(false);
    expect(history.usedBytes).toBeLessThanOrEqual(24);
  });
});

describe("绘图会话与另存命名", () => {
  it("复位回到默认状态", () => {
    const session = createDrawSession();
    session.tool = "mosaic";
    session.color = "#ffffff";
    session.width = 12;
    session.fontSize = 48;
    session.dirty = true;
    session.canUndo = true;
    resetDrawSession(session);
    expect(session.tool).toBe("pencil");
    expect(session.color).toBe("#e5534b");
    expect(session.width).toBe(4);
    expect(session.fontSize).toBe(24);
    expect(session.dirty).toBe(false);
    expect(session.canUndo).toBe(false);
  });

  it("工具表十件（P1 补油漆桶/裁剪）、图标均已登记", () => {
    expect(DRAW_TOOLS.map((tool) => tool.key)).toEqual([
      "pencil",
      "eraser",
      "fill",
      "line",
      "arrow",
      "rect",
      "ellipse",
      "mosaic",
      "text",
      "crop",
    ]);
    for (const tool of DRAW_TOOLS) expect(tool.icon.length).toBeGreaterThan(0);
  });

  it("空白画布默认 1280×720", () => {
    expect(BLANK_CANVAS_SIZE).toEqual({ width: 1280, height: 720 });
  });

  it("空白画布文件名 drawn-*、落点 = 文档同级 assets/", () => {
    const at = new Date(2026, 8, 19, 12, 0, 30);
    expect(drawnFileName(at, 0)).toBe("drawn-20260919-120030.png");
    expect(drawnFileName(at, 1)).toBe("drawn-20260919-120030-1.png");
    expect(drawnRelPath("docs/note.md", "drawn-1.png")).toBe("docs/assets/drawn-1.png");
    expect(drawnRelPath("note.md", "drawn-1.png")).toBe("assets/drawn-1.png");
  });

  it("另存文件名带时间戳、落点与原图同目录、一律 .png", () => {
    const at = new Date(2026, 8, 17, 15, 30, 5);
    expect(editedFileName(at, 0)).toBe("edited-20260917-153005.png");
    expect(editedFileName(at, 2)).toBe("edited-20260917-153005-2.png");
    expect(editedRelPath("docs/assets/shot.jpg", "edited-1.png")).toBe("docs/assets/edited-1.png");
    expect(editedRelPath("shot.jpg", "edited-1.png")).toBe("edited-1.png");
  });
});

describe("油漆桶（扫描线洪水填充）", () => {
  function canvas(pixels: number[][]): { data: Uint8ClampedArray; w: number; h: number } {
    // 3 通道整数矩阵 → RGBA；0=黑 255=白，非 0/255 的值用于验证容差
    const w = pixels.length;
    const h = pixels[0].length;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let x = 0; x < w; x += 1) {
      for (let y = 0; y < h; y += 1) {
        const byte = (y * w + x) * 4;
        data[byte] = pixels[x][y];
        data[byte + 1] = pixels[x][y];
        data[byte + 2] = pixels[x][y];
        data[byte + 3] = 255;
      }
    }
    return { data, w, h };
  }

  it("把同色连通区填成目标色；包围盒只盖被改写的区域", () => {
    // pixels[x][y] = 像素 (x,y) 的灰度（列主序）：3×3 白底 + 中行一条横向黑带
    //   黑带 = (0,1),(1,1),(2,1)；四角是白（互不相干）
    const c = canvas([
      [255, 0, 255],
      [255, 0, 255],
      [255, 0, 255],
    ]);
    const rect = floodFill(c.data, c.w, c.h, 1, 1, [229, 83, 75]);
    expect(rect).toEqual({ x: 0, y: 1, w: 3, h: 1 });
    const at = (x: number, y: number) => (y * c.w + x) * 4;
    expect(c.data[at(0, 1)]).toBe(229);
    expect(c.data[at(2, 1)]).toBe(229);
    expect(c.data[at(1, 0)]).toBe(255); // 白底没动
    expect(c.data[at(1, 2)]).toBe(255);
  });

  it("容差吃掉抗锯齿过渡带（±48 内视为同色）", () => {
    const c = canvas([
      [100, 130, 200],
      [100, 100, 200],
    ]);
    // 从 100 出发，130 在容差内 → 一起填；200 在容差外 → 保留
    const rect = floodFill(c.data, c.w, c.h, 0, 0, [10, 10, 10], 48);
    expect(rect).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    const at = (x: number, y: number) => (y * c.w + x) * 4;
    expect(c.data[at(0, 1)]).toBe(10);
    expect(c.data[at(1, 2)]).toBe(200);
  });

  it("起点即目标色 → null（不白扫）；越界坐标 → null", () => {
    const c = canvas([
      [50, 50],
      [50, 50],
    ]);
    expect(floodFill(c.data, c.w, c.h, 0, 0, [50, 50, 50])).toBeNull();
    expect(floodFill(c.data, c.w, c.h, 9, 9, [1, 2, 3])).toBeNull();
  });

  it("对角不通不连（4 邻接，不是 8 邻接）", () => {
    const c = canvas([
      [255, 0],
      [0, 255],
    ]);
    const rect = floodFill(c.data, c.w, c.h, 0, 0, [9, 9, 9]);
    expect(rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});
