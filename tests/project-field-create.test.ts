/**
 * 新建字段的持久化契约：命令写入 app.db（后端保证），前端要做的是——
 * 创建后刷新字段列表、把新字段纳入当前视图的显示字段，并让它可被渲染。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());

const created = {
  id: "p1-f9",
  projectId: "p1",
  kind: "single_select",
  name: "迭代",
  options: [
    { id: "p1-f9-o0", name: "S1", color: "#f85149" },
    { id: "p1-f9-o1", name: "S2", color: "#d29922" },
  ],
  position: 2,
};

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {
    projectList: vi.fn().mockResolvedValue([{ id: "p1", name: "板" }]),
    projectFields: vi
      .fn()
      .mockResolvedValueOnce([
        { id: "p1-f1", projectId: "p1", kind: "builtin_status", name: "Status", options: [], position: 0 },
        { id: "p1-f2", projectId: "p1", kind: "single_select", name: "优先级", options: [], position: 1 },
      ])
      .mockResolvedValue([
        { id: "p1-f1", projectId: "p1", kind: "builtin_status", name: "Status", options: [], position: 0 },
        { id: "p1-f2", projectId: "p1", kind: "single_select", name: "优先级", options: [], position: 1 },
        created,
      ]),
    projectItemList: vi.fn().mockResolvedValue([]),
    projectRepoList: vi.fn().mockResolvedValue([]),
    projectFieldCreate: vi.fn().mockResolvedValue(created),
  },
}));

async function freshStore() {
  const { useProjectsStore } = await import("../src/stores/projects");
  const { createPinia, setActivePinia } = await import("pinia");
  setActivePinia(createPinia());
  return useProjectsStore();
}

describe("新建字段", () => {
  it("创建后刷新字段表，并把新字段纳入当前视图的显示字段", async () => {
    const store = await freshStore();
    store.select("p1");
    await Promise.resolve();

    expect(store.view.fields).not.toContain(created.id);
    await store.createField("迭代", "single_select", ["S1", "S2"]);

    expect(store.fieldByViewKey(created.id)?.name).toBe("迭代");
    expect(store.fieldName(created.id)).toBe("迭代");
    expect(store.view.fields).toContain(created.id);
  });

  it("字段目录把自建字段列在项目字段段，且带出选项值", async () => {
    const store = await freshStore();
    store.select("p1");
    await Promise.resolve();
    await store.createField("迭代", "single_select", ["S1", "S2"]);

    const entry = store.fieldCatalogue.find((f) => f.id === created.id);
    expect(entry?.section).toBe("project");
    const item = {
      id: "i1",
      projectId: "p1",
      kind: "draft",
      repoId: null,
      number: null,
      draftTitle: "卡片",
      draftBody: null,
      rank: "1024",
      addedAt: "2026-09-01T00:00:00Z",
      repoLabel: null,
      ghost: false,
      fieldValues: { "p1-f9": "p1-f9-o1" },
    } as never;
    expect(store.cellOf(created.id, item)).toEqual({ text: "S2", color: "#d29922" });
  });
});
