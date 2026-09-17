// @vitest-environment jsdom
/**
 * 拖拽移动的判定逻辑（纯函数）与多选状态机。
 *
 * 这一层的每条规则都来自"真机上会出丑"的场景：
 * 放进自己所在目录 = 白闪一下提示；放进自己的子孙 = 操作系统报错；
 * Shift 范围选择必须按**可见行**算（折叠的目录不该被选中）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import {
  anyDroppable,
  baseName,
  canDropInto,
  droppablePaths,
  joinPath,
  parentOf,
  resolveDropTarget,
} from "../src/knowledge/tree-drag";
import { useKnowledgeStore } from "../src/stores/knowledge";
import { waitForDom } from "./test-support";

describe("落点合法性", () => {
  it("放进别的目录：合法", () => {
    expect(canDropInto("a.md", "sub")).toBe(true);
    expect(canDropInto("sub/a.md", "")).toBe(true);
  });

  it("放进自己所在的目录：不合法（空操作）", () => {
    expect(canDropInto("a.md", "")).toBe(false);
    expect(canDropInto("sub/a.md", "sub")).toBe(false);
  });

  it("目录放进自己 / 放进自己的子孙：不合法", () => {
    expect(canDropInto("sub", "sub")).toBe(false);
    expect(canDropInto("sub", "sub/inner")).toBe(false);
    expect(canDropInto("sub", "subx")).toBe(true); // 前缀相似但不是子孙
  });

  it("整批里有一个能放就算有合法落点；实际只移合法的那几个", () => {
    const paths = ["sub/a.md", "sub"];
    expect(anyDroppable(paths, "sub")).toBe(false); // a.md 原地、sub 进自己 → 都不合法
    expect(droppablePaths(paths, "other")).toEqual(["sub/a.md", "sub"]);
    expect(droppablePaths(paths, "sub/inner")).toEqual(["sub/a.md"]);
  });
});

describe("路径工具", () => {
  it("父目录 / 末段 / 拼接", () => {
    expect(parentOf("a.md")).toBe("");
    expect(parentOf("sub/a.md")).toBe("sub");
    expect(baseName("sub/a.md")).toBe("a.md");
    expect(joinPath("", "a.md")).toBe("a.md");
    expect(joinPath("sub", "a.md")).toBe("sub/a.md");
  });
});

describe("命中行 → 落点目录", () => {
  it("目录行 = 放进它；文件行 = 放进它所在目录，并给出插入线位置", () => {
    expect(resolveDropTarget({ rel: "sub", kind: "dir" })).toEqual({ dir: "sub", before: null });
    expect(resolveDropTarget({ rel: "sub/a.md", kind: "file" })).toEqual({ dir: "sub", before: "sub/a.md" });
  });

  it("空白处 = 根目录", () => {
    expect(resolveDropTarget(null)).toEqual({ dir: "", before: null });
  });
});

describe("多选状态机", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  const seed = () => {
    const store = useKnowledgeStore();
    store.root = "/tmp/kb";
    store.children = {
      "": [
        { name: "sub", rel: "sub", kind: "dir", size: 0, mtimeMs: 1, ignored: false },
        { name: "a.md", rel: "a.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
        { name: "b.md", rel: "b.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
      ],
      sub: [{ name: "inner.md", rel: "sub/inner.md", kind: "file", size: 1, mtimeMs: 1, ignored: false }],
    } as never;
    return store;
  };

  it("单击单选；⌘ 点击加选/取消；Esc 清空", () => {
    const store = seed();
    store.selectOnly("a.md");
    expect(store.selection).toEqual(["a.md"]);
    store.toggleSelection("b.md");
    expect(store.selection).toEqual(["a.md", "b.md"]);
    store.toggleSelection("a.md");
    expect(store.selection).toEqual(["b.md"]);
    store.clearSelection();
    expect(store.selection).toEqual([]);
  });

  it("Shift 范围选择按**可见行**算，折叠目录的子项不参与", () => {
    const store = seed();
    store.selectOnly("a.md");
    store.selectRange("b.md");
    // 可见行：sub、a.md、b.md（sub 折叠 → inner.md 不在其中）
    expect(store.selection).toEqual(["a.md", "b.md"]);
    // 再从 b.md 反向选到 sub：**锚点不变**（还在 a.md），范围收成 sub..a.md
    // —— 连续 Shift 点击都是相对同一个锚点伸缩，VS Code 同款
    store.selectRange("sub");
    expect(store.selection).toEqual(["sub", "a.md"]);
  });

  it("展开目录后，范围选择包含其子项", () => {
    const store = seed();
    store.expanded = { sub: true };
    store.selectOnly("sub");
    store.selectRange("b.md");
    expect(store.selection).toEqual(["sub", "sub/inner.md", "a.md", "b.md"]);
  });

  it("全选 = 当前可见行；移动后选中集迁到新位置", () => {
    const store = seed();
    store.selectAllVisible();
    expect(store.selection).toEqual(["sub", "a.md", "b.md"]);
    store.setSelection(["other/a.md"]);
    expect(store.selection).toEqual(["other/a.md"]);
    store.removeFromSelection(["other/a.md"]);
    expect(store.selection).toEqual([]);
  });
});

describe("多选 + 批量菜单（接线）", () => {
  beforeEach(async () => {
    vi.resetModules();
  });

  it("多选后菜单只给批量动作，文案带数量；删除走整批", async () => {
    const { createApp, h, nextTick } = await import("vue");
    const { useI18n } = await import("../src/i18n");
    useI18n().setLocale("zh-CN");
    const { default: KnowledgeTree } = await import("../src/knowledge/KnowledgeTree.vue");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useKnowledgeStore();
    // resetModules 之后 store 是新的实例：树数据要在这一份上重新铺
    store.root = "/tmp/kb";
    store.children = {
      "": [
        { name: "a.md", rel: "a.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
        { name: "b.md", rel: "b.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
      ],
    } as never;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(KnowledgeTree, { onSwitchRoot: () => {} }) });
    app.use(pinia);
    app.mount(host);
    await nextTick();

    // 选中两项，然后在其中一项上右键
    store.selectOnly("a.md");
    store.toggleSelection("b.md");
    const row = host.querySelector<HTMLElement>('[data-rel="b.md"]')!;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await nextTick();

    const labels = [...document.querySelectorAll(".am-menu [role=menuitem], .am-menu .am-item")].map((el) => el.textContent ?? "");
    const joined = labels.join("|");
    expect(joined, "应给出带数量的批量文案").toContain("复制 2 项");
    expect(joined).toContain("删除 2 项");
    expect(joined, "单文件语义的项在多选时不该出现").not.toContain("重命名");
    app.unmount();
    host.remove();
  });
});

describe("拖拽移动（接线：手势事件 + 落点判定 + 移动命令）", () => {
  it("按下 → 移动 → 松手落在目录上：调 kbMove，且吃掉紧随的 click", async () => {
    vi.resetModules();
    const { createApp, h, nextTick } = await import("vue");
    const { useI18n } = await import("../src/i18n");
    useI18n().setLocale("zh-CN");
    const move = vi.fn(async (_root: string, _from: string, _to: string) => ({ rel: _to }));
    vi.doMock("../src/api", () => ({
      isTauri: () => false,
      api: {
        kbMove: move,
        kbListDir: async () => [],
        kbStat: async () => ({ exists: true, kind: "dir", size: 0, mtimeMs: 1 }),
        kbCopy: async () => ({ rel: "" }),
        kbCreate: async () => ({ rel: "" }),
        kbRename: async () => ({ rel: "" }),
        kbDelete: async () => {},
        kbPickRoot: async () => null,
      },
    }));
    const { default: KnowledgeTree } = await import("../src/knowledge/KnowledgeTree.vue");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useKnowledgeStore();
    store.root = "/tmp/kb";
    store.children = {
      "": [
        { name: "sub", rel: "sub", kind: "dir", size: 0, mtimeMs: 1, ignored: false },
        { name: "a.md", rel: "a.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
      ],
    } as never;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(KnowledgeTree, { onSwitchRoot: () => {} }) });
    app.use(pinia);
    app.mount(host);
    await nextTick();

    const fileRow = host.querySelector<HTMLElement>('[data-rel="a.md"]')!;
    const dirRow = host.querySelector<HTMLElement>('[data-rel="sub"]')!;
    // jsdom 没有布局，命中测试直接指向目标行
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => dirRow;

    fileRow.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 40 }));
    await nextTick();
    expect(document.querySelector(".tree-drag-ghost"), "拖动中应有跟随光标的幽灵").not.toBeNull();
    expect(dirRow.className, "落点应高亮").toContain("drop-target");

    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 }));
    await waitForDom(() => {
      expect(move).toHaveBeenCalledWith("/tmp/kb", "a.md", "sub/a.md");
    });
    expect(document.querySelector(".tree-drag-ghost"), "松手后幽灵要清掉").toBeNull();

    document.elementFromPoint = originalFromPoint;
    app.unmount();
    host.remove();
    vi.doUnmock("../src/api");
  });

  it("拖到自己所在的目录：不给落点反馈，也不发移动命令", async () => {
    vi.resetModules();
    const { createApp, h, nextTick } = await import("vue");
    const { useI18n } = await import("../src/i18n");
    useI18n().setLocale("zh-CN");
    const move = vi.fn(async () => ({ rel: "" }));
    vi.doMock("../src/api", () => ({
      isTauri: () => false,
      api: {
        kbMove: move,
        kbListDir: async () => [],
        kbStat: async () => ({ exists: true, kind: "dir", size: 0, mtimeMs: 1 }),
        kbCopy: async () => ({ rel: "" }),
        kbCreate: async () => ({ rel: "" }),
        kbRename: async () => ({ rel: "" }),
        kbDelete: async () => {},
        kbPickRoot: async () => null,
      },
    }));
    const { default: KnowledgeTree } = await import("../src/knowledge/KnowledgeTree.vue");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useKnowledgeStore();
    store.root = "/tmp/kb";
    store.children = {
      "": [
        { name: "a.md", rel: "a.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
        { name: "b.md", rel: "b.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
      ],
    } as never;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(KnowledgeTree, { onSwitchRoot: () => {} }) });
    app.use(pinia);
    app.mount(host);
    await nextTick();

    const fileRow = host.querySelector<HTMLElement>('[data-rel="a.md"]')!;
    const sibling = host.querySelector<HTMLElement>('[data-rel="b.md"]')!;
    const originalFromPoint = document.elementFromPoint;
    document.elementFromPoint = () => sibling; // 落到同目录的另一个文件上 = 原地不动

    fileRow.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 40 }));
    await nextTick();
    expect(sibling.className, "原地落点不该有高亮").not.toContain("drop-target");
    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 }));
    await nextTick();
    expect(move).not.toHaveBeenCalled();

    document.elementFromPoint = originalFromPoint;
    app.unmount();
    host.remove();
    vi.doUnmock("../src/api");
  });
});

describe("鼠标交互接线（⌘/Shift 点击真的改选中集）", () => {
  it("⌘ 点击第二行 → 两行都在选中集里；Shift 点击 → 范围选中", async () => {
    vi.resetModules();
    const { createApp, h, nextTick } = await import("vue");
    const { default: KnowledgeTree } = await import("../src/knowledge/KnowledgeTree.vue");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useKnowledgeStore();
    store.root = "/tmp/kb";
    store.children = {
      "": [
        { name: "a.md", rel: "a.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
        { name: "b.md", rel: "b.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
        { name: "c.md", rel: "c.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
      ],
    } as never;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(KnowledgeTree, { onSwitchRoot: () => {} }) });
    app.use(pinia);
    app.mount(host);
    await nextTick();

    const row = (rel: string) => host.querySelector<HTMLElement>(`[data-rel="${rel}"]`)!;
    row("a.md").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(store.selection).toEqual(["a.md"]);

    row("b.md").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await nextTick(); // 类名要等一次渲染
    expect(store.selection, "⌘ 点击应加选").toEqual(["a.md", "b.md"]);
    // 视觉：两行都要有选中类（这条曾经因为样式写错组件而"看起来没生效"）
    expect(row("a.md").className).toContain("selected");
    expect(row("b.md").className).toContain("selected");

    row("c.md").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    await nextTick();
    expect(store.selection, "Shift 从锚点 b.md 选到 c.md").toEqual(["b.md", "c.md"]);

    // ⌘ 点**已选中**的项 → 取消它（Shift 已经把选中集换成 b/c，这里点 c.md 取消）
    row("c.md").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await nextTick();
    expect(store.selection, "⌘ 点已选中的项应取消它").toEqual(["b.md"]);
    // ⌘ 点未选中的项 → 加回来
    row("c.md").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await nextTick();
    expect(store.selection).toEqual(["b.md", "c.md"]);

    app.unmount();
    host.remove();
  });
});

describe("多选视觉语义（VS Code 口径）", () => {
  it("选中态只有一种外观：⌘ 加选不切预览，选中集里不混另一种高亮", async () => {
    vi.resetModules();
    const { createApp, h, nextTick } = await import("vue");
    const { default: KnowledgeTree } = await import("../src/knowledge/KnowledgeTree.vue");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useKnowledgeStore();
    store.root = "/tmp/kb";
    store.children = {
      "": [
        { name: "a.md", rel: "a.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
        { name: "b.md", rel: "b.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
      ],
    } as never;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(KnowledgeTree, { onSwitchRoot: () => {} }) });
    app.use(pinia);
    app.mount(host);
    await nextTick();

    const row = (rel: string) => host.querySelector<HTMLElement>(`[data-rel="${rel}"]`)!;
    row("a.md").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(store.selected, "普通点击会打开预览").toBe("a.md");

    // ⌘ 点击另一项：只加选，**不**改当前打开（否则"打开项"在选中集里乱跳）
    row("b.md").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await nextTick();
    expect(store.selected, "⌘ 点击不该切换预览").toBe("a.md");
    expect(store.selection).toEqual(["a.md", "b.md"]);
    // 两行都有 selected；只有其中之一可能同时是 active
    expect(row("a.md").className).toContain("selected");
    expect(row("b.md").className).toContain("selected");
    expect(row("a.md").className, "a.md 同时是当前打开项").toContain("active");
    expect(row("b.md").className, "b.md 不是当前打开项").not.toContain("active");

    app.unmount();
    host.remove();
  });
});

describe("多选视觉语义（VS Code 口径）", () => {
  it("⌘ 加选不切预览；选中集里不混另一种高亮", async () => {
    vi.resetModules();
    const { createApp, h, nextTick } = await import("vue");
    const { default: KnowledgeTree } = await import("../src/knowledge/KnowledgeTree.vue");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useKnowledgeStore();
    store.root = "/tmp/kb";
    store.children = {
      "": [
        { name: "a.md", rel: "a.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
        { name: "b.md", rel: "b.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
      ],
    } as never;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(KnowledgeTree, { onSwitchRoot: () => {} }) });
    app.use(pinia);
    app.mount(host);
    await nextTick();

    const row = (rel: string) => host.querySelector<HTMLElement>(`[data-rel="${rel}"]`)!;
    row("a.md").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(store.selected, "普通点击会打开预览").toBe("a.md");

    row("b.md").dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    await nextTick();
    expect(store.selected, "⌘ 点击不该切换预览").toBe("a.md");
    expect(store.selection).toEqual(["a.md", "b.md"]);
    expect(row("a.md").className).toContain("selected");
    expect(row("b.md").className).toContain("selected");

    app.unmount();
    host.remove();
  });

  it("拖拽期间：按下要掐掉默认行为（否则会连出原生文字选区）", async () => {
    vi.resetModules();
    const { createApp, h, nextTick } = await import("vue");
    const { default: KnowledgeTree } = await import("../src/knowledge/KnowledgeTree.vue");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useKnowledgeStore();
    store.root = "/tmp/kb";
    store.children = {
      "": [
        { name: "sub", rel: "sub", kind: "dir", size: 0, mtimeMs: 1, ignored: false },
        { name: "a.md", rel: "a.md", kind: "file", size: 1, mtimeMs: 1, ignored: false },
      ],
    } as never;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(KnowledgeTree, { onSwitchRoot: () => {} }) });
    app.use(pinia);
    app.mount(host);
    await nextTick();

    const fileRow = host.querySelector<HTMLElement>('[data-rel="a.md"]')!;
    const dirRow = host.querySelector<HTMLElement>('[data-rel="sub"]')!;
    document.elementFromPoint = () => dirRow;
    const down = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5 });
    fileRow.dispatchEvent(down);
    expect(down.defaultPrevented, "pointerdown 必须 preventDefault（原生选区就是从这开始的）").toBe(true);

    window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 40, clientY: 40 }));
    await nextTick();
    expect(document.body.classList.contains("tree-dragging"), "拖拽中应给 body 打标记（禁选择 + 抓取光标）").toBe(true);

    window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 40, clientY: 40 }));
    await nextTick();
    expect(document.body.classList.contains("tree-dragging"), "松手后要撤掉标记").toBe(false);

    app.unmount();
    host.remove();
  });
});
