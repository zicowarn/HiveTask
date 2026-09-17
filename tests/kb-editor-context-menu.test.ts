// @vitest-environment jsdom
/**
 * 右键菜单链路：CM6 的 contextmenu 事件 → 宿主拿到锚点 → ActionMenu 以坐标模式落点。
 *
 * 为什么拆两步测：真机右键在自动化里不可靠（AppleScript 无法右键、macOS 把 F10 当媒体键），
 * 所以把"事件接线"与"菜单渲染"分别用 DOM 断言锁住，真机只留观感确认。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, ref, type App } from "vue";

// 编辑器会拉 api（Tauri 命令）；本测试只关心事件接线，用桩替掉
vi.mock("../src/api", () => ({ isTauri: () => false, api: {} }));

const mounted: App[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe("编辑器右键 → 锚点", () => {
  it("在编辑区派发 contextmenu 会带上指针坐标", async () => {
    const MarkdownEditor = (await import("../src/knowledge/editor/MarkdownEditor.vue")).default;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const seen: { x: number; y: number }[] = [];
    const app = createApp({
      render: () =>
        h(MarkdownEditor, {
          modelValue: "# 标题\n正文\n",
          onContextmenu: (payload: { x: number; y: number }) => seen.push(payload),
        }),
    });
    mounted.push(app);
    app.mount(host);

    const content = host.querySelector(".cm-content");
    expect(content).toBeTruthy();
    content!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 321, clientY: 234 }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ x: 321, y: 234 });
  });
});

describe("ActionMenu 坐标锚点模式", () => {
  it("给定 anchor 时不渲染触发器，菜单以 fixed 落在该点", async () => {
    const ActionMenu = (await import("../src/components/ActionMenu.vue")).default;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({
      render: () =>
        h(ActionMenu, {
          items: [{ value: "b", label: "加粗" }],
          anchor: { x: 100, y: 120 },
          size: "ui",
        }),
    });
    mounted.push(app);
    app.mount(host);

    expect(host.querySelector(".am-trigger")).toBeNull();
    const menu = document.body.querySelector(".am-menu") as HTMLElement | null;
    expect(menu).toBeTruthy();
    // 类名 + 内联坐标
    expect(menu!.classList.contains("am-menu--anchored")).toBe(true);
    expect(menu!.style.left).toBe("100px");
    expect(menu!.style.top).toBe("120px");
    // **关键回归**：锚点菜单必须 Teleport 到 body —— 否则会被祖先的 overflow 裁掉，
    // 或被祖先的 containing block 影响定位（实测：树里的菜单因此"根本没出现"，
    // 页签菜单则退化成贴在页签条下方）。jsdom 不做级联计算，所以这里锁"挂到哪"这一层。
    expect(host.contains(menu!)).toBe(false);
    expect(document.body.contains(menu!)).toBe(true);
  });

  it("选中某项：抛 pick 并通知宿主关闭（@close）", async () => {
    const ActionMenu = (await import("../src/components/ActionMenu.vue")).default;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const picked: string[] = [];
    const closed = ref(0);
    const app = createApp({
      render: () =>
        h(ActionMenu, {
          items: [{ value: "i", label: "斜体" }],
          anchor: { x: 10, y: 10 },
          onPick: (value: string) => picked.push(value),
          onClose: () => {
            closed.value += 1;
          },
        }),
    });
    mounted.push(app);
    app.mount(host);

    const item = document.body.querySelector(".am-item") as HTMLElement | null;
    expect(item).toBeTruthy();
    item!.click();
    expect(picked).toEqual(["i"]);
    expect(closed.value).toBe(1);
  });
});
