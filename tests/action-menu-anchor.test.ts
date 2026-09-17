// @vitest-environment jsdom
/**
 * 锚点菜单的**视口边界处理**：点了靠近窗口底部的条目时，菜单必须向上翻，
 * 否则下半截落在窗口外（用户实测截图：树底部文件的菜单被窗口下沿切掉）。
 *
 * jsdom 没有布局引擎，所以这里 stub 菜单的 getBoundingClientRect 与窗口尺寸，
 * 断言的是**算出来的落点**这一层。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";

const apps: App[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  document.body.querySelectorAll(".am-menu").forEach((el) => el.remove());
  vi.restoreAllMocks();
});

/**
 * 尺寸桩必须在**挂载前**打好：组件渲染后会先量一次再做翻转判断，
 * 挂载后再 stub 就晚了一步（第一版测试就是这么写错的）。
 */
async function mountMenu(anchor: { x: number; y: number }, menuSize: { w: number; h: number }) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: menuSize.w,
    height: menuSize.h,
    top: 0,
    left: 0,
    right: menuSize.w,
    bottom: menuSize.h,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);

  const ActionMenu = (await import("../src/components/ActionMenu.vue")).default;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    render: () => h(ActionMenu, { items: [{ value: "a", label: "A" }], anchor, size: "ui" }),
  });
  apps.push(app);
  app.mount(host);
  await nextTick();
  await nextTick();
  const menu = document.body.querySelector<HTMLElement>(".am-menu")!;
  return { host, menu };
}

describe("锚点菜单位置", () => {
  it("空间充足：落在指针处", async () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    const { menu } = await mountMenu({ x: 100, y: 100 }, { w: 200, h: 300 });
    expect(menu.style.top).toBe("100px");
    expect(menu.style.left).toBe("100px");
  });

  it("下方空间不足：向上翻（不再被窗口下沿切掉）", async () => {
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
    // 指针在 560（距底部 40px），菜单高 300 → 必须上翻到 260
    const { menu } = await mountMenu({ x: 100, y: 560 }, { w: 200, h: 300 });
    expect(menu.style.top).toBe("260px");
  });

  it("右侧空间不足：向左收（不越出右边缘）", async () => {
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true });
    const { menu } = await mountMenu({ x: 380, y: 100 }, { w: 300, h: 200 });
    // 400 - 8(margin) - 300 = 92
    expect(menu.style.left).toBe("92px");
  });
});
