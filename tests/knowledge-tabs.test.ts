/**
 * 知识库页签与树的纯逻辑回归：
 * - 打开文件 → 生成页签（去重、保序）；再次点击只激活不新增；
 * - 关闭激活中的页签 → 落到右邻（没有则左邻）；
 * - 关闭非激活页签不影响当前激活；
 * - 根切换（setRoot）清空页签与展开态，避免旧根的文件留在新根上。
 * 组件渲染走实机/浏览器预览（scripts/smoke.md）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());

vi.mock("../src/api", () => ({
  isTauri: () => false,
  api: {},
}));

async function freshStore() {
  const { useKnowledgeStore } = await import("../src/stores/knowledge");
  const { createPinia, setActivePinia } = await import("pinia");
  setActivePinia(createPinia());
  return useKnowledgeStore();
}

describe("knowledge 文件页签", () => {
  it("打开文件生成页签且去重保序", async () => {
    const store = await freshStore();
    store.select("docs/a.md");
    store.select("README.md");
    store.select("docs/a.md"); // 再次点击 → 只激活
    expect(store.tabs).toEqual(["docs/a.md", "README.md"]);
    expect(store.selected).toBe("docs/a.md");
  });

  it("关闭激活页签落到右邻，没有右邻则落左邻", async () => {
    const store = await freshStore();
    store.select("a.md");
    store.select("b.md");
    store.select("c.md");

    store.select("b.md");
    store.closeTab("b.md");
    expect(store.tabs).toEqual(["a.md", "c.md"]);
    expect(store.selected).toBe("c.md"); // 右邻

    store.closeTab("c.md");
    expect(store.selected).toBe("a.md"); // 无右邻 → 左邻
  });

  it("关闭非激活页签不影响当前激活", async () => {
    const store = await freshStore();
    store.select("a.md");
    store.select("b.md");
    store.closeTab("a.md");
    expect(store.tabs).toEqual(["b.md"]);
    expect(store.selected).toBe("b.md");
  });

  it("关闭最后一个页签回到空态", async () => {
    const store = await freshStore();
    store.select("a.md");
    store.closeTab("a.md");
    expect(store.tabs).toEqual([]);
    expect(store.selected).toBeNull();
  });

  it("换根清空页签、展开态与选中", async () => {
    const store = await freshStore();
    store.select("a.md");
    store.expanded = { docs: true };
    await store.setRoot("/tmp/another-root");
    expect(store.tabs).toEqual([]);
    expect(store.selected).toBeNull();
    expect(store.expanded).toEqual({});
  });
});

// ---- 页签族的关闭命令（VS Code 页签右键菜单的语义）----

describe("页签关闭族与固定", () => {
  async function withTabs(...rels: string[]) {
    const store = await freshStore();
    for (const rel of rels) store.select(rel);
    return store;
  }

  it("Close Others：保留自己与固定页签，其余关闭", async () => {
    const store = await withTabs("a.md", "b.md", "c.md", "d.md");
    store.togglePin("b.md");
    store.closeOthers("c.md");
    expect(store.tabs).toEqual(["b.md", "c.md"]);
    expect(store.selected).toBe("c.md");
  });

  it("Close to the Right：只关右侧，且跳过固定页签", async () => {
    const store = await withTabs("a.md", "b.md", "c.md", "d.md");
    store.togglePin("d.md");
    // 固定把 d 移到最前（VS Code 语义）
    expect(store.tabs).toEqual(["d.md", "a.md", "b.md", "c.md"]);
    store.closeToRight("a.md");
    // a 右侧的 b、c 关闭；d 固定且已在左侧，保留
    expect(store.tabs).toEqual(["d.md", "a.md"]);
  });

  it("Close All：全部关闭但保留固定页签", async () => {
    const store = await withTabs("a.md", "b.md", "c.md");
    store.togglePin("b.md");
    store.closeAll();
    expect(store.tabs).toEqual(["b.md"]);
    expect(store.selected).toBe("b.md");
  });

  it("Close Saved：只关未修改的，返回关闭数量；脏页签保留", async () => {
    const store = await withTabs("a.md", "b.md", "c.md");
    const meta = { text: "", encoding: "UTF-8", bom: false, eol: "\n", size: 0, mtimeMs: 1 };
    store.setBuffer("a.md", { text: "改了", meta, dirty: true });
    store.setBuffer("b.md", { text: "没改", meta, dirty: false });
    const closed = store.closeSaved();
    expect(closed).toBe(2); // b、c
    expect(store.tabs).toEqual(["a.md"]);
    expect(store.isDirty("a.md")).toBe(true);
  });

  it("固定页签排到最前；取消固定回到固定组之后的第一位", async () => {
    const store = await withTabs("a.md", "b.md", "c.md");
    store.togglePin("c.md");
    expect(store.tabs).toEqual(["c.md", "a.md", "b.md"]);
    store.togglePin("c.md");
    // 解除固定后落在"固定组之后的第一位"（此处无固定页签 → 回到最前）
    expect(store.tabs).toEqual(["c.md", "a.md", "b.md"]);

    // 有固定页签时更直观：b 固定，c 解除固定后应排在 b 之后
    const store2 = await withTabs("a.md", "b.md", "c.md");
    store2.togglePin("b.md");
    store2.togglePin("c.md");
    expect(store2.tabs).toEqual(["b.md", "c.md", "a.md"]);
    store2.togglePin("c.md");
    // c 解除固定后落在固定组（b）之后的第一位 —— 位置恰好不变
    expect(store2.tabs).toEqual(["b.md", "c.md", "a.md"]);
  });

  it("关闭页签会丢弃它的缓冲（不留孤儿草稿）", async () => {
    const store = await withTabs("a.md", "b.md");
    const meta = { text: "", encoding: "UTF-8", bom: false, eol: "\n", size: 0, mtimeMs: 1 };
    store.setBuffer("a.md", { text: "x", meta, dirty: true });
    store.closeTab("a.md");
    expect(store.buffers["a.md"]).toBeUndefined();
  });

  it("dirtyTabs 列出未保存的页签（关闭前确认用）", async () => {
    const store = await withTabs("a.md", "b.md");
    const meta = { text: "", encoding: "UTF-8", bom: false, eol: "\n", size: 0, mtimeMs: 1 };
    store.setBuffer("b.md", { text: "x", meta, dirty: true });
    expect(store.dirtyTabs()).toEqual(["b.md"]);
    expect(store.dirtyTabs(["a.md"])).toEqual([]);
  });
});
