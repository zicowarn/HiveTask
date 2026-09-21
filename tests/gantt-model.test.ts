import { describe, expect, it } from "vitest";
import { arrowPath, buildGanttTree, defaultEndField, ganttRange, type GanttTask } from "../src/panels/gantt-model";
import type { IssueRelations } from "../src/api";

const rel = (partial: Partial<IssueRelations>): IssueRelations => ({
  blockedBy: [],
  blocking: [],
  subIssues: [],
  ...partial,
});

const task = (over: Partial<GanttTask> & { id: string }): GanttTask => ({
  repoId: "r1",
  number: null,
  title: over.id,
  start: null,
  end: null,
  relations: null,
  ...over,
});

describe("甘特 WBS 树投影", () => {
  it("父行后紧跟子树、depth 递增（subIssues 方向建边）", () => {
    const nodes = buildGanttTree([
      task({ id: "p", number: "1", relations: rel({ subIssues: [{ number: "2", title: "c", state: "OPEN" }] }) }),
      task({ id: "c", number: "2" }),
      task({ id: "z", number: "9" }),
    ]);
    expect(nodes.map((n) => [n.id, n.depth])).toEqual([
      ["p", 0],
      ["c", 1],
      ["z", 0],
    ]);
    expect(nodes[0].childCount).toBe(1);
  });

  it("parent 方向同样建边（两个方向取并集，不重复）", () => {
    const nodes = buildGanttTree([
      task({ id: "p", number: "1", relations: rel({ subIssues: [{ number: "2", title: "", state: "OPEN" }] }) }),
      task({ id: "c", number: "2", relations: rel({ parent: { number: "1", title: "", state: "OPEN" } }) }),
    ]);
    expect(nodes.map((n) => n.id)).toEqual(["p", "c"]);
    expect(nodes[1].depth).toBe(1);
  });

  it("父行无自身日期时按子行聚合（min start / max end）", () => {
    const nodes = buildGanttTree([
      task({ id: "p", number: "1", relations: rel({ subIssues: [
        { number: "2", title: "", state: "OPEN" },
        { number: "3", title: "", state: "OPEN" },
      ] }) }),
      task({ id: "a", number: "2", start: "2026-05-10", end: "2026-05-12" }),
      task({ id: "b", number: "3", start: "2026-05-01", end: "2026-05-20T10:00:00Z" }),
    ]);
    const p = nodes.find((n) => n.id === "p")!;
    expect(p.start).toBe("2026-05-01");
    expect(p.end).toBe("2026-05-20");
  });

  it("父行自身有日期时不聚合（自身优先）", () => {
    const nodes = buildGanttTree([
      task({ id: "p", number: "1", start: "2026-06-01", end: "2026-06-02",
             relations: rel({ subIssues: [{ number: "2", title: "", state: "OPEN" }] }) }),
      task({ id: "c", number: "2", start: "2026-05-01", end: "2026-05-30" }),
    ]);
    const p = nodes.find((n) => n.id === "p")!;
    expect(p.start).toBe("2026-06-01");
    expect(p.end).toBe("2026-06-02");
  });

  it("跨仓库同编号不误连（repoId 必须一致）", () => {
    const nodes = buildGanttTree([
      task({ id: "a", repoId: "r1", number: "1", relations: rel({ subIssues: [{ number: "2", title: "", state: "OPEN" }] }) }),
      task({ id: "b", repoId: "r2", number: "2" }),
    ]);
    expect(nodes.every((n) => n.depth === 0)).toBe(true);
    expect(nodes[0].childCount).toBe(0);
  });

  it("父不在板内的 sub-issue 保持顶层（不悬空、不失真）", () => {
    const nodes = buildGanttTree([
      task({ id: "c", number: "2", relations: rel({ parent: { number: "99", title: "", state: "OPEN" } }) }),
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].depth).toBe(0);
  });

  it("依赖：blockedBy 命中板内条目才成边（含跨仓库不命中）", () => {
    const nodes = buildGanttTree([
      task({ id: "a", number: "1", relations: rel({ blockedBy: [
        { number: "2", title: "", state: "OPEN" },
        { number: "98", title: "", state: "OPEN" }, // 板外 → 不成边
      ] }) }),
      task({ id: "b", number: "2" }),
      task({ id: "x", repoId: "r2", number: "2" }), // 跨仓同名 → 不命中
    ]);
    const a = nodes.find((n) => n.id === "a")!;
    expect(a.dependsOn).toEqual(["b"]);
  });

  it("进度：来自 subIssuesSummary；无摘要为 null（不造假 0）", () => {
    const nodes = buildGanttTree([
      task({ id: "a", number: "1", relations: rel({ subSummary: { total: 4, completed: 1 } }) }),
      task({ id: "b", number: "2" }),
    ]);
    expect(nodes[0].progress).toBe(25);
    expect(nodes[1].progress).toBeNull();
  });

  it("子Issue 环防御：不无限递归、每节点只出现一次", () => {
    const nodes = buildGanttTree([
      task({ id: "a", number: "1", relations: rel({ subIssues: [{ number: "2", title: "", state: "OPEN" }] }) }),
      task({ id: "b", number: "2", relations: rel({ subIssues: [{ number: "1", title: "", state: "OPEN" }] }) }),
    ]);
    expect(nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });
});

describe("甘特时间窗与箭头几何", () => {
  const today = new Date(2026, 4, 20);
  it("窗口覆盖全部行日期并留边距", () => {
    const nodes = buildGanttTree([
      task({ id: "a", number: "1", start: "2026-05-10", end: "2026-06-01" }),
    ]);
    const { from, to } = ganttRange(nodes, today);
    expect(from.getTime()).toBeLessThan(new Date(2026, 4, 10).getTime());
    expect(to.getTime()).toBeGreaterThan(new Date(2026, 5, 1).getTime());
  });

  it("无日期行时围绕今天前后各 30 天", () => {
    const { from, to } = ganttRange([], today);
    expect(Math.round((today.getTime() - from.getTime()) / 86400000)).toBe(30);
    expect(Math.round((to.getTime() - today.getTime()) / 86400000)).toBe(30);
  });

  it("箭头：目标在右侧走 L 形（右出→竖直→指向左缘）", () => {
    const { d, tipX, tipY } = arrowPath(100, 10, 200, 50);
    expect(d.startsWith("M 100 10 H 108 V 50")).toBe(true);
    expect(tipX).toBe(200);
    expect(tipY).toBe(50);
  });

  it("箭头：目标在左侧（回折）绕行下方、仍指向目标左缘", () => {
    const { d, tipX, tipY } = arrowPath(300, 10, 120, 50);
    expect(d).toContain("V 64"); // 绕行到目标行下方 14px
    expect(tipX).toBe(120);
    expect(tipY).toBe(50);
  });
});

describe("进度：closed 权威 100%", () => {
  it("闭合条目无子 Issue 摘要也按 100", () => {
    const nodes = buildGanttTree([task({ id: "a", number: "1", closed: true })]);
    expect(nodes[0].progress).toBe(100);
  });

  it("闭合优先于子 Issue 摘要（状态是完成的权威语义）", () => {
    const nodes = buildGanttTree([
      task({ id: "a", number: "1", closed: true, relations: rel({ subSummary: { total: 4, completed: 1 } }) }),
    ]);
    expect(nodes[0].progress).toBe(100);
  });

  it("未闭合仍走摘要；两者皆无为 null", () => {
    const open = buildGanttTree([task({ id: "a", number: "1", relations: rel({ subSummary: { total: 2, completed: 1 } }) })]);
    const bare = buildGanttTree([task({ id: "b", number: "2" })]);
    expect(open[0].progress).toBe(50);
    expect(bare[0].progress).toBeNull();
  });
});

describe("结束字段默认推断（甘特 = 工期，不默认「无」）", () => {
  const f = (id: string, name: string) => ({ id, name });

  it("名字带 结束/End/Due 的字段优先", () => {
    const fields = [f("a", "开始日期"), f("b", "结束日期"), f("c", "复查")];
    expect(defaultEndField(fields, "a")).toBe("b");
    expect(defaultEndField([f("a", "Start"), f("z", "Deadline"), f("b", "End date")], "a")).toBe("b");
  });

  it("没有语义命名 → 剩余第一个（不与开始同字段）", () => {
    expect(defaultEndField([f("a", "日期一"), f("b", "日期二")], "a")).toBe("b");
  });

  it("只有一个日期字段 → null（诚实单日条，不硬造工期）", () => {
    expect(defaultEndField([f("a", "开始")], "a")).toBeNull();
  });
});
