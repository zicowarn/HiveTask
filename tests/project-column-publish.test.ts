/**
 * 列双向同步的本地半边：绑定了线上项目的项目，本地改列（新建/改名/删除/调序）
 * 后必须把选项表发布到线上；未绑定的纯本地项目不发布。发布失败不回滚本地
 * （离线优先），只把原因写进 publishError 供面板显示。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());

const statusField = {
  id: "p1-f1",
  projectId: "p1",
  kind: "builtin_status",
  name: "Status",
  position: 0,
  options: [
    { id: "p1-s1", name: "Backlog", color: "#59636e", description: "" },
    { id: "p1-s2", name: "Ready", color: "#0969da", description: "" },
  ],
};

/** 深拷贝：store 传进来的 options 是 Vue 响应式代理，structuredClone 会抛 DataCloneError。 */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function mockApi(platformRef: string | null) {
  // 后端才是真源：mock 里也让字段表随写入变化，重载后才反映得到新选项
  let current = structuredClone(statusField);
  return {
    isTauri: () => true,
    api: {
      projectList: vi.fn().mockResolvedValue([{ id: "p1", name: "板", platformRef }]),
      projectFields: vi.fn(async () => [clone(current)]),
      projectItemList: vi.fn().mockResolvedValue([]),
      projectRepoList: vi.fn().mockResolvedValue([]),
      projectFieldOptionAdd: vi.fn(async (_fieldId: string, name: string, color?: string) => {
        current = {
          ...current,
          options: [...current.options, { id: `p1-s${current.options.length + 1}`, name, color: color ?? "#59636e", description: "" }],
        };
        return clone(current);
      }),
      projectFieldSetOptions: vi.fn(async (_fieldId: string, options: typeof statusField.options) => {
        current = { ...current, options: clone(options) };
      }),
      projectPublishColumns: vi.fn().mockResolvedValue(1),
    },
  };
}

const state = { api: mockApi("https://github.com/users/zicowarn/projects/13") };

vi.mock("../src/api", () => ({
  isTauri: () => true,
  get api() {
    return state.api.api;
  },
}));

async function freshStore(platformRef: string | null) {
  state.api = mockApi(platformRef);
  const { useProjectsStore } = await import("../src/stores/projects");
  const { createPinia, setActivePinia } = await import("pinia");
  setActivePinia(createPinia());
  const store = useProjectsStore();
  await store.loadProjects(); // projects 表是 selected.platformRef 的来源
  store.select("p1");
  await Promise.resolve();
  return store;
}

describe("本地列 → 线上发布", () => {
  it("新建列后把选项表发布到线上", async () => {
    const store = await freshStore("https://github.com/users/zicowarn/projects/13");
    await store.addOption("p1-f1", "In review", "#8250df");
    expect(state.api.api.projectPublishColumns).toHaveBeenCalledWith("p1");
    expect(store.publishError).toBeNull();
  });

  it("改名 / 删除 / 调序都发布（列设置双向一致）", async () => {
    const store = await freshStore("https://github.com/users/zicowarn/projects/13");
    await store.updateOption("p1-f1", "p1-s2", { name: "Ready for dev", color: "#0969da", description: "" });
    await store.moveOption("p1-f1", "p1-s2", -1);
    await store.deleteOption("p1-f1", "p1-s1");
    expect(state.api.api.projectPublishColumns).toHaveBeenCalledTimes(3);
  });

  it("未绑定线上项目的本地项目不发布", async () => {
    const store = await freshStore(null);
    await store.addOption("p1-f1", "In review", "#8250df");
    expect(state.api.api.projectPublishColumns).not.toHaveBeenCalled();
    expect(store.publishError).toBeNull();
  });

  it("发布失败：原因可读、本地列不回滚", async () => {
    const store = await freshStore("https://github.com/users/zicowarn/projects/13");
    state.api.api.projectPublishColumns.mockRejectedValueOnce(
      new Error("发布列需要 gh 令牌的 project 权限：执行 `gh auth refresh -h github.com -s project` 后重试"),
    );
    await store.addOption("p1-f1", "In review", "#8250df");
    expect(store.publishError).toContain("project 权限");
    // 本地写入已完成（离线优先）：字段仍带上了新选项
    expect(store.fields.find((f) => f.id === "p1-f1")?.options.length).toBe(3);
  });
});
