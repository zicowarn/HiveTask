/**
 * 项目分析的图表数学（Q9 燃起图）：坐标映射与堆叠最容易错在边界上——空数据、
 * 单点、选项被删后历史档位、坐标翻转，这里逐条钉死；面板只负责把结果塞进 SVG。
 */
import { describe, expect, it } from "vitest";
import {
  NO_STATUS,
  axisDays,
  buildStack,
  cumulativeBelow,
  distributionByOption,
  pointX,
  stackBandPath,
  stackBarRects,
  valueY,
  type SnapshotRow,
} from "../src/panels/analytics-model";

function snap(day: string, total: number, status: Record<string, number>, labels: Record<string, string> = {}): SnapshotRow {
  return { day, total, status, labels };
}

describe("燃起图：窗口时间轴与堆叠序列", () => {
  it("有轴时按轴对齐：没记录的日子是 null（≠ 0），记录下标与连续段一并给出", () => {
    const rows = [
      snap("2026-09-20", 4, { todo: 2, doing: 2 }, { todo: "Todo", doing: "Doing" }),
      // 09-21 没记录（没打开过应用）
      snap("2026-09-22", 6, { todo: 3, doing: 2, done: 1 }, { todo: "Todo", doing: "Doing", done: "Done" }),
    ];
    const chart = buildStack(rows, ["todo", "doing", "done"], ["2026-09-20", "2026-09-21", "2026-09-22"]);
    expect(chart.axis).toEqual(["2026-09-20", "2026-09-21", "2026-09-22"]);
    expect(chart.recorded).toEqual([0, 2]);
    expect(chart.spans, "空档把趋势断开（不连线、不编 0）").toEqual([[0], [2]]);
    expect(chart.series[0].values).toEqual([2, null, 3]);
    expect(chart.series[2].values, "当天没有的档位补 0（当天有记录）").toEqual([0, null, 1]);
    expect(chart.max).toBe(6);
  });

  it("没有轴时退回记录日自建轴（旧行为可用）", () => {
    const chart = buildStack([snap("2026-09-21", 2, { todo: 2 }, { todo: "Todo" })], ["todo"]);
    expect(chart.axis).toEqual(["2026-09-21"]);
    expect(chart.spans).toEqual([[0]]);
  });

  it("连续多天归为一段；跨空档再起一段", () => {
    const rows = ["2026-09-18", "2026-09-19", "2026-09-22"].map((d, i) =>
      snap(d, i + 1, { todo: i + 1 }, { todo: "Todo" }),
    );
    const chart = buildStack(rows, ["todo"], ["2026-09-18", "2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"]);
    expect(chart.spans).toEqual([[0, 1], [4]]);
  });

  it("选项被删后历史档位仍保留，并排在已知档位之后（用快照自带的名字）", () => {
    const rows = [snap("2026-09-21", 3, { todo: 2, "ghost-opt": 1 }, { todo: "Todo", "ghost-opt": "已删列" })];
    const chart = buildStack(rows, ["todo", "doing"], ["2026-09-21"]);
    expect(chart.series.map((s) => s.key)).toEqual(["todo", "ghost-opt"]);
    expect(chart.series[1].label, "历史用当时的名字").toBe("已删列");
  });

  it("空数据与全零：不炸、y 上限兜底为 1（避免除零）", () => {
    expect(buildStack([], ["todo"])).toMatchObject({ axis: [], recorded: [], series: [], max: 1, spans: [] });
    expect(buildStack([snap("2026-09-21", 0, { todo: 0 }, { todo: "Todo" })], ["todo"], ["2026-09-21"]).max).toBe(1);
    expect(
      buildStack([snap("2026-09-21", 0, { todo: 0 })], ["todo"], ["2026-09-21"]).series,
      "零计数的档位不出图",
    ).toEqual([]);
  });
});

describe("窗口时间轴", () => {
  it("连续、含今天、跨月正确", () => {
    expect(axisDays("2026-09-22", 3)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22"]);
    expect(axisDays("2026-03-01", 3)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(axisDays("2026-09-22", 1)).toEqual(["2026-09-22"]);
    expect(axisDays("bad", 5)).toEqual([]);
  });
});

describe("坐标映射", () => {
  it("x 等距；单点居中（不能除以 0）", () => {
    expect(pointX(0, 3, 200, 20, 20)).toBe(20);
    expect(pointX(2, 3, 200, 20, 20)).toBe(180);
    expect(pointX(1, 3, 200, 20, 20)).toBe(100);
    expect(pointX(0, 1, 200, 20, 20)).toBe(100);
  });

  it("轴长度 = 窗口长度：今天落在右端（不是把单点画在正中）", () => {
    // 30 天窗口、只有最后一天有记录 → 该点应在右端
    expect(pointX(29, 30, 640, 30, 14)).toBe(626);
    // 单元素轴才居中
    expect(pointX(0, 1, 640, 30, 14)).toBe(328);
  });

  it("y 翻转（值大在上）、max 为 0 不除零、超上限的值夹在画布内", () => {
    expect(valueY(10, 10, 100, 0, 0)).toBe(0);
    expect(valueY(0, 10, 100, 0, 0)).toBe(100);
    expect(valueY(0, 0, 100, 0, 0), "max=0 兜底：值为 0 时落在底边").toBe(100);
    expect(valueY(5, 0, 100, 0, 0), "脏数据（值 > max）夹到顶边，不画出界").toBe(0);
    expect(valueY(-3, 10, 100, 0, 0), "负值夹到 0").toBe(100);
    // 内边距参与
    expect(valueY(10, 10, 100, 10, 10)).toBe(10);
    expect(valueY(0, 10, 100, 10, 10)).toBe(90);
  });
});

describe("堆叠带、单日柱与累计下沿", () => {
  it("逐日累计下沿：无记录日为 null；第 0 档恒 0", () => {
    const chart = buildStack(
      [snap("2026-09-20", 3, { a: 2, b: 1 }), snap("2026-09-22", 3, { a: 1, b: 2 })],
      ["a", "b"],
      ["2026-09-20", "2026-09-21", "2026-09-22"],
    );
    expect(cumulativeBelow(chart.series, 0)).toEqual([0, null, 0]);
    expect(cumulativeBelow(chart.series, 1)).toEqual([2, null, 1]);
  });

  it("带路径按段闭合（上沿左→右、下沿右→左）；单点段返回空串交给当日柱", () => {
    const chart = buildStack(
      [snap("2026-09-20", 3, { a: 2, b: 1 }), snap("2026-09-21", 4, { a: 2, b: 2 })],
      ["a", "b"],
      ["2026-09-20", "2026-09-21"],
    );
    const d = stackBandPath(chart.series[1].values, cumulativeBelow(chart.series, 1), chart.spans[0], {
      ...{ max: chart.max, width: 100, height: 50, axisLength: chart.axis.length },
      padLeft: 0,
      padRight: 0,
      padTop: 0,
      padBottom: 0,
    });
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d.match(/L/g)!.length).toBe(3);
    expect(stackBandPath([1], [0], [0], { max: 1, width: 10, height: 10, axisLength: 1 })).toBe("");
  });

  it("单日柱：从下沿往上叠，高度与值成比例（零宽面积看不见的补救）", () => {
    const chart = buildStack(
      [snap("2026-09-22", 3, { a: 2, b: 1 })],
      ["a", "b"],
      ["2026-09-22"],
    );
    const rects = stackBarRects(
      chart.series.map((s) => ({ ...s, values: [s.values[0] ?? 0] })),
      [cumulativeBelow(chart.series, 0)[0] ?? 0, cumulativeBelow(chart.series, 1)[0] ?? 0],
      { max: chart.max, height: 100 },
    );
    expect(rects.map((r) => r.key)).toEqual(["a", "b"]);
    // a = 底部 0..2/3 → y=33,h=67；b = 2/3..1 → y=0,h=33
    expect(Math.round(rects[0].y)).toBe(33);
    expect(Math.round(rects[0].h)).toBe(67);
    expect(Math.round(rects[1].y)).toBe(0);
    expect(Math.round(rects[1].h)).toBe(33);
  });
});

describe("当前分布（柱状，不依赖历史）", () => {
  it("按选项顺序输出，含计数；无状态值归到 __none__（草稿/未落列）", () => {
    const bars = distributionByOption(
      [
        { itemId: "1", value: "todo" },
        { itemId: "2", value: "todo" },
        { itemId: "3", value: null },
        { itemId: "4", value: "done" },
      ],
      [
        { id: "todo", name: "Todo", color: "#111" },
        { id: "doing", name: "Doing", color: "#222" },
        { id: "done", name: "Done", color: "#333" },
      ],
    );
    expect(bars.map((b) => [b.key, b.count])).toEqual([
      ["todo", 2],
      ["done", 1],
      [NO_STATUS, 1],
    ]);
    expect(bars.filter((b) => b.count === 0), "零值档位不出柱").toHaveLength(0);
  });

  it("取值不在选项定义里（列被删）也照实出现，不吞数据", () => {
    const bars = distributionByOption(
      [{ itemId: "1", value: "ghost" }, { itemId: "2", value: "todo" }],
      [{ id: "todo", name: "Todo", color: "#111" }],
    );
    expect(bars.map((b) => b.key).sort()).toEqual(["ghost", "todo"]);
    expect(bars.reduce((n, b) => n + b.count, 0)).toBe(2);
  });
});
