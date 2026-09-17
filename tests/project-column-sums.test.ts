/**
 * 列头合计与卡片 chip 的数据口径（平台取证 2026-09-16）：
 * - 计数不再作为「合计」文本项，平台用列头 CounterLabel 胶囊单独渲染；
 * - 数字字段（Estimate）默认开启求和（平台视图 Field sum: Count, Estimate），
 *   一次 version 升级后由用户自行开关。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());

const fields = [
  {
    id: "p1-f1",
    projectId: "p1",
    kind: "builtin_status",
    name: "Status",
    position: 0,
    options: [{ id: "p1-s1", name: "Done", color: "#bc4c00", description: "" }],
  },
  { id: "p1-f2", projectId: "p1", kind: "number", name: "Estimate", position: 1, options: [] },
  {
    id: "p1-f3",
    projectId: "p1",
    kind: "single_select",
    name: "Size",
    position: 2,
    options: [{ id: "p1-z1", name: "M", color: "#d1242f", description: "" }],
  },
];

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {
    projectList: vi.fn().mockResolvedValue([{ id: "p1", name: "板" }]),
    projectFields: vi.fn().mockResolvedValue(fields),
    projectItemList: vi.fn().mockResolvedValue([
      { id: "i1", projectId: "p1", kind: "issue", fieldValues: { "p1-f1": "p1-s1", "p1-f2": "2" } },
      { id: "i2", projectId: "p1", kind: "issue", fieldValues: { "p1-f1": "p1-s1", "p1-f2": "4" } },
    ]),
    projectRepoList: vi.fn().mockResolvedValue([]),
  },
}));

async function freshStore() {
  const { useProjectsStore } = await import("../src/stores/projects");
  const { createPinia, setActivePinia } = await import("pinia");
  setActivePinia(createPinia());
  const store = useProjectsStore();
  await store.loadProjects();
  return store;
}

describe("列头合计与求和默认值", () => {
  it("新字段（同步补出的 Size）默认进入**每个**视图的显示字段——否则切到 Table / Priority board 就看不到", async () => {
    const store = await freshStore();
    expect(store.view.fields).toContain("p1-f3");
    for (const entry of store.views) {
      expect(entry.config.fields, `${entry.name} 视图`).toContain("p1-f3");
      expect(entry.config.sumFieldIds, `${entry.name} 视图求和`).toContain("p1-f2");
    }
  });

  it("用户删掉的字段不会被再次放回（见过的字段只入一次）", async () => {
    const store = await freshStore();
    store.toggleField("p1-f3"); // 用户从显示字段里关掉
    expect(store.view.fields).not.toContain("p1-f3");

    const { createPinia, setActivePinia } = await import("pinia");
    const { useProjectsStore } = await import("../src/stores/projects");
    setActivePinia(createPinia());
    const again = useProjectsStore();
    await again.loadProjects();
    expect(again.view.fields).not.toContain("p1-f3");
  });

  it("列的合计只出数字字段求和（计数由列头胶囊渲染）", async () => {
    const store = await freshStore();
    const sums = store.columnSums("p1-s1", null);
    expect(sums).toEqual([{ label: "Estimate", value: 6 }]);
    expect(sums.some((s) => s.label === "计数")).toBe(false);
  });

  it("估算字段默认开启求和（version 升级一次性回填），用户关掉后不再回填", async () => {
    const store = await freshStore();
    expect(store.view.sumFieldIds).toContain("p1-f2");

    store.toggleSum("p1-f2"); // 用户关掉
    expect(store.view.sumFieldIds).not.toContain("p1-f2");

    // 重开（新 pinia 实例 = 应用重启）后不得再自动回填
    const { createPinia, setActivePinia } = await import("pinia");
    const { useProjectsStore } = await import("../src/stores/projects");
    setActivePinia(createPinia());
    const again = useProjectsStore();
    await again.loadProjects();
    expect(again.view.sumFieldIds).not.toContain("p1-f2");
  });
});
