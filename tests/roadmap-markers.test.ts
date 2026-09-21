import { describe, expect, it } from "vitest";
import { collectMarkers, collectDateMarkers } from "../src/panels/modes/roadmap-markers";
import type { ProjectItem } from "../src/api";

/** 最小条目：只有投影用到的 repoId + entity.milestone。 */
function item(repoId: string | null, milestone?: string) {
  return {
    repoId,
    entity: milestone
      ? ({ milestone } as unknown as NonNullable<ProjectItem["entity"]>)
      : null,
  };
}

const meta = (label: string, list: { title: string; dueOn: string | null }[]) => ({ label, list });

describe("roadmap 里程碑标记线投影", () => {
  it("同仓同里程碑多条目只画一条线", () => {
    const out = collectMarkers(
      [item("r1", "v1.0"), item("r1", "v1.0"), item("r1", "v1.0")],
      { r1: meta("repoA", [{ title: "v1.0", dueOn: "2026-10-31T23:59:59Z" }]) },
    );
    expect(out).toEqual([{ key: "r1::v1.0", title: "v1.0", date: "2026-10-31" }]);
  });

  it("无截止日 / 仓库元数据缺席 → 诚实缺席（不造假日期）", () => {
    const out = collectMarkers(
      [item("r1", "无期"), item("r2", "未同步"), item("r1", "有期")],
      { r1: meta("a", [{ title: "无期", dueOn: null }, { title: "有期", dueOn: "2026-05-01T00:00:00Z" }]) },
    );
    expect(out).toEqual([{ key: "r1::有期", title: "有期", date: "2026-05-01" }]);
  });

  it("草稿（无 entity）与悬挂条目（无 repoId）不产生线", () => {
    const out = collectMarkers(
      [item("r1"), item(null, "孤儿里程碑")],
      { r1: meta("a", []) },
    );
    expect(out).toEqual([]);
  });

  it("跨仓同名里程碑两条线都在，标题补仓库名消歧", () => {
    const out = collectMarkers(
      [item("r1", "v1.0"), item("r2", "v1.0")],
      {
        r1: meta("前端", [{ title: "v1.0", dueOn: "2026-06-01T00:00:00Z" }]),
        r2: meta("后端", [{ title: "v1.0", dueOn: "2026-05-01T00:00:00Z" }]),
      },
    );
    expect(out).toEqual([
      { key: "r2::v1.0", title: "v1.0（后端）", date: "2026-05-01" },
      { key: "r1::v1.0", title: "v1.0（前端）", date: "2026-06-01" },
    ]);
  });

  it("RFC3339 截止日取日期部分，结果按日期升序", () => {
    const out = collectMarkers(
      [item("r1", "晚"), item("r1", "早"), item("r1", "中")],
      {
        r1: meta("a", [
          { title: "晚", dueOn: "2026-12-31T23:59:59Z" },
          { title: "早", dueOn: "2026-01-01T00:00:00Z" },
          { title: "中", dueOn: "2026-06-15T12:00:00Z" },
        ]),
      },
    );
    expect(out.map((m) => m.title)).toEqual(["早", "中", "晚"]);
    expect(out.every((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date))).toBe(true);
  });
});

describe("roadmap 日期标记（Start date / Due date 小三角）", () => {
  const items = [
    { fieldValues: { f1: "2026-05-20" } },
    { fieldValues: { f1: "2026-05-20" } }, // 同日去重
    { fieldValues: { f1: "2026-05-03T10:00:00Z" } },
    { fieldValues: { f1: "2026-05-21" } },
    { fieldValues: {} }, // 无值跳过
    { fieldValues: { f1: "不是日期" } }, // 非法跳过
  ] as Pick<ProjectItem, "fieldValues">[];

  it("取字段全部日期值去重升序；缺失/非法值跳过", () => {
    expect(collectDateMarkers(items, "f1")).toEqual(["2026-05-03", "2026-05-20", "2026-05-21"]);
  });

  it("无字段（未配置开始/结束日期字段）→ 空列表", () => {
    expect(collectDateMarkers(items, null)).toEqual([]);
    expect(collectDateMarkers(items, undefined)).toEqual([]);
  });
});
