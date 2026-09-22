// @vitest-environment jsdom
/**
 * 条目归档（对齐 GitHub Projects，2026-09-22 取证）：**归档 = 移出所有视图、
 * 保留条目上下文**——既不是删除，也不是「从项目中移除」。守三件事：
 * ① 视图取数单点（preSliceItems）排除归档项——Board/Table/Roadmap/甘特/导出/
 *    计数同源，一处生效（用户点名的"表格、线路图、优先级显示不过滤"就是这个）；
 * ② 已归档条目只从 archivedItems 出（与 filteredItems 互补、不相交）；
 * ③ 归档/还原就地生效 + 新面板在册（元数据齐了但忘 registerPanel 的老坑）。
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
    options: [
      { id: "p1-s1", name: "Todo", color: "#0969da", description: "" },
      { id: "p1-s2", name: "Done", color: "#1a7f37", description: "" },
    ],
  },
];

function item(id: string, archivedAt: string | null) {
  return {
    id,
    projectId: "p1",
    kind: "issue",
    repoId: null,
    originUrl: null,
    originType: null,
    number: id.replace("i", ""),
    draftTitle: null,
    draftBody: null,
    rank: "1024",
    addedAt: "2026-09-01T00:00:00Z",
    archivedAt,
    repoLabel: null,
    ghost: false,
    fieldValues: { "p1-f1": "p1-s1" },
    entity: { title: `条目 ${id}`, state: "OPEN", assignees: [], labels: [] },
  };
}

const ITEMS = [item("i1", null), item("i2", "2026-09-20T10:00:00Z"), item("i3", "2026-09-22T09:00:00Z")];

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {
    projectList: vi.fn().mockResolvedValue([{ id: "p1", name: "板" }]),
    projectFields: vi.fn().mockResolvedValue(fields),
    projectItemList: vi.fn().mockResolvedValue(ITEMS),
    projectRepoList: vi.fn().mockResolvedValue([]),
    projectItemArchive: vi.fn().mockResolvedValue(undefined),
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

const ids = (list: { id: string }[]) => list.map((i) => i.id).sort();

describe("条目归档", () => {
  it("视图侧排除归档项；archivedItems 只出归档项（互补不相交）", async () => {
    const store = await freshStore();
    expect(ids(store.filteredItems)).toEqual(["i1"]);
    // 归档时间倒序（最近归档在前）：桌面适配，平台归档页未定义排序
    expect(store.archivedItems.map((i) => i.id)).toEqual(["i3", "i2"]);
  });

  it("归档后条目立刻从视图消失并进归档列表（就地更新，不整表重载）", async () => {
    const store = await freshStore();
    await store.archiveItem("i1", true);
    expect(store.filteredItems).toEqual([]);
    expect(store.archivedItems.map((i) => i.id)).toContain("i1");
    // 记录值也要跟着落库（视图侧只看"有没有"，但时间戳要能显示）
    expect(store.archivedItems.find((i) => i.id === "i1")?.archivedAt).toBeTruthy();
  });

  it("还原后条目回到视图、离开归档列表", async () => {
    const store = await freshStore();
    await store.archiveItem("i2", false);
    expect(ids(store.filteredItems)).toEqual(["i1", "i2"]);
    expect(store.archivedItems.map((i) => i.id)).toEqual(["i3"]);
  });

  it("面板在册：元数据 + 组件表都登记了（否则弹层能选中、面板渲染不出来）", async () => {
    // registry 会拉进整个组件图（含 xterm，读 navigator.userAgent）——本文件为
    // 浏览器全局打的桩只有 language，先还回真实现再导入。
    vi.unstubAllGlobals();
    const { panelTypes } = await import("../src/workbench/panel-types");
    const { resolvePanel } = await import("../src/workbench/registry");
    const meta = panelTypes.find((p) => p.type === "project.archive");
    expect(meta, "panel-types 缺 project.archive").toBeTruthy();
    expect(meta!.category).toBe("editorCat.projects");
    expect(resolvePanel("project.archive")?.component, "应已注册组件").toBeTruthy();
  });
});

describe("归档面板（已归档条目 Editor）", () => {
  async function mountPanel() {
    const { createApp, nextTick } = await import("vue");
    const { createPinia, setActivePinia } = await import("pinia");
    const { useProjectsStore } = await import("../src/stores/projects");
    const { api } = await import("../src/api");
    const Panel = (await import("../src/panels/ProjectArchivePanel.vue")).default;

    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useProjectsStore();
    await store.loadProjects();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(Panel);
    app.use(pinia);
    app.mount(host);
    await nextTick();
    return { app, host, store, api };
  }

  it("只列归档项，行内还原即调用归档命令（archived=false）", async () => {
    const { app, host, api } = await mountPanel();
    try {
      const titles = [...host.querySelectorAll(".ar-title")].map((el) => el.textContent?.trim());
      expect(titles).toEqual(["条目 i3", "条目 i2"]);

      const buttons = host.querySelectorAll<HTMLButtonElement>(".ar-restore-one");
      expect(buttons.length).toBe(2);
      buttons[1]!.click();
      await vi.waitFor(() => expect(host.querySelectorAll(".ar-row").length).toBe(1));
      expect(api.projectItemArchive).toHaveBeenCalledWith("i2", false);
    } finally {
      app.unmount();
      host.remove();
    }
  });

  it("全选后批量还原，勾选态随列表清空", async () => {
    const { app, host, api } = await mountPanel();
    try {
      const all = host.querySelector<HTMLInputElement>(".ar-all input")!;
      all.click();
      await vi.waitFor(() =>
        expect(host.querySelector<HTMLButtonElement>(".ar-restore")).not.toBeNull(),
      );
      host.querySelector<HTMLButtonElement>(".ar-restore")!.click();
      await vi.waitFor(() => {
        const calls = (api.projectItemArchive as unknown as { mock: { calls: unknown[][] } }).mock.calls;
        expect(calls.length).toBe(2);
      });
      expect(host.querySelectorAll(".ar-row").length).toBe(0);
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
