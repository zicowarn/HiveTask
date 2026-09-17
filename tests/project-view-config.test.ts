/**
 * 项目视图配置回归测试——修过的缺口：筛选从不落盘、筛选/排序存全局键
 * （两个项目共用一套）。现口径：整套配置按项目分键存 JSON、写路径统一落盘
 * （sync 深 watch），切项目各读各的。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());

vi.mock("../src/api", () => ({
  isTauri: () => false,
  api: {},
}));

async function freshStore() {
  const { useProjectsStore } = await import("../src/stores/projects");
  const { createPinia, setActivePinia } = await import("pinia");
  setActivePinia(createPinia());
  return useProjectsStore();
}

function stored(projectId: string) {
  const raw = localStorage.getItem(`hivetask.project-view.${projectId}`);
  return raw ? JSON.parse(raw) : null;
}

describe("项目视图配置", () => {
  it("改任一维度都按项目分键落盘", async () => {
    const store = await freshStore();
    store.select("p1");
    store.view.filter = "status:Ready";
    store.setSortBy("priority");
    store.setSortDesc(true);
    store.setColumnFieldId("f-priority");
    store.toggleField("source");

    expect(stored("p1")).toMatchObject({
      filter: "status:Ready",
      sortBy: "priority",
      sortDesc: true,
      columnFieldId: "f-priority",
    });
    expect(stored("p1").fields).not.toContain("source");
  });

  it("切项目各读各的配置，不串味、也不清掉刚落下的值", async () => {
    const store = await freshStore();
    store.select("p1");
    store.setSortBy("added");
    expect(store.view.sortBy).toBe("added");

    store.select("p2");
    expect(store.view.sortBy).toBe("manual");

    store.select("p1");
    expect(store.view.sortBy).toBe("added");
    // 切回后紧接着写：回填是同拍的，不会被旧值覆盖
    store.view.filter = "docs";
    expect(store.view.filter).toBe("docs");
  });

  it("旧版配置（无 version）加载时把新增固定字段补回来，用户设置保留", async () => {
    localStorage.setItem(
      "hivetask.project-view.p1",
      JSON.stringify({ filter: "x", sortBy: "priority", fields: ["status", "priority", "source"] }),
    );
    const store = await freshStore();
    store.select("p1");

    expect(store.view.filter).toBe("x");
    expect(store.view.sortBy).toBe("priority");
    // 目录扩容前存的 fields 只有三项——标题等新固定字段必须补回
    expect(store.view.fields).toContain("title");
    expect(store.view.fields).toContain("labels");
    expect(store.view.fields).toContain("status");
  });

  it("存储损坏时回落默认配置而不是抛错", async () => {
    localStorage.setItem("hivetask.project-view.p1", "{ not json");
    const store = await freshStore();
    store.select("p1");
    expect(store.view.sortBy).toBe("manual");
    expect(store.view.fields.length).toBeGreaterThan(0);
  });
});
