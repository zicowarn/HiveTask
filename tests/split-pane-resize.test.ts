// @vitest-environment jsdom
/**
 * 分隔条拖拽的两个护栏（用户实测：双 Editor 时拖分隔条，扫过的面板文本与控件
 * 会被"选中"）：
 * ① pointerdown 必须掐掉默认行为——原生"文字选择"从按下那一刻就开始，事后再补
 *    `user-select: none` 收不回来（KnowledgeTree 踩过同款，注释留在那边）；
 * ② 拖拽期给 body 挂全局锁（禁选 + 拖拽光标），且**每条**收尾路径都要解锁
 *    （pointerup / pointercancel / lostpointercapture / 组件卸载）——漏一条，
 *    全应用的文字选择就一直是关的。
 * jsdom 不布局、也不派发指针事件，矩形与事件都手工来（同 action-menu-anchor 的分层）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import SplitPane from "../src/workbench/SplitPane.vue";

const apps: App[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
  document.body.className = "";
  vi.restoreAllMocks();
});

/** jsdom 的矩形一律是零：容器不给尺寸就算不出比例（宽 400 × 高 300 作基准）。 */
function mountPane(direction: "horizontal" | "vertical" = "horizontal") {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  } as DOMRect);

  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({ render: () => h(SplitPane, { direction, initialRatio: 0.4 }) });
  apps.push(app);
  hosts.push(host);
  app.mount(host);

  return {
    app,
    pane: host.querySelector<HTMLElement>(".split-pane")!,
    divider: host.querySelector<HTMLElement>(".divider")!,
    first: host.querySelector<HTMLElement>(".pane")!,
  };
}

/** jsdom 没有 PointerEvent：用 MouseEvent 顶替（组件只读 button/clientX/Y）。 */
function pointer(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
}

const locked = (): boolean => document.body.classList.contains("pane-resizing");

describe("分隔条拖拽护栏", () => {
  it("pointerdown 掐掉默认行为（原生选区就是从这一步开始的）", () => {
    const { divider } = mountPane();
    const down = pointer("pointerdown", { clientX: 160 });
    divider.dispatchEvent(down);
    expect(down.defaultPrevented, "不 preventDefault 就会拖出连片蓝底选区").toBe(true);
  });

  it("拖拽期间挂全局锁并按 X 轴改比例，pointerup 后解锁", async () => {
    const { pane, divider, first } = mountPane("horizontal");

    divider.dispatchEvent(pointer("pointerdown", { clientX: 160 }));
    expect(locked()).toBe(true);
    expect(document.body.classList.contains("pane-resizing-x")).toBe(true);
    await nextTick(); // body 的锁是直改 DOM（同步可见），divider 的 active 走 Vue 渲染（下一帧）
    expect(divider.classList.contains("active")).toBe(true);

    pane.dispatchEvent(pointer("pointermove", { clientX: 200 })); // 200 / 400 = 50%
    await nextTick();
    expect(first.style.width).toBe("50%");

    pane.dispatchEvent(pointer("pointerup"));
    await nextTick();
    expect(locked()).toBe(false);
    expect(document.body.className).not.toContain("pane-resizing-x");
    expect(divider.classList.contains("active")).toBe(false);
  });

  it("竖分栏：按 Y 轴改比例，锁是 row-resize 变体", async () => {
    const { pane, divider, first } = mountPane("vertical");

    divider.dispatchEvent(pointer("pointerdown", { clientY: 40 }));
    expect(document.body.classList.contains("pane-resizing-y")).toBe(true);

    pane.dispatchEvent(pointer("pointermove", { clientY: 150 })); // 150 / 300 = 50%
    await nextTick();
    expect(first.style.height).toBe("50%");

    pane.dispatchEvent(pointer("pointerup"));
    expect(locked()).toBe(false);
  });

  it("pointercancel 与 lostpointercapture 也要解锁（锁漏了 = 全应用选不中文字）", () => {
    const first = mountPane();
    first.divider.dispatchEvent(pointer("pointerdown", { clientX: 160 }));
    expect(locked()).toBe(true);
    first.divider.dispatchEvent(pointer("pointercancel"));
    expect(locked(), "指针在窗口外抬起（cancel）不解锁就会锁死全局选择").toBe(false);

    const second = mountPane();
    second.divider.dispatchEvent(pointer("pointerdown", { clientX: 160 }));
    expect(locked()).toBe(true);
    second.divider.dispatchEvent(new Event("lostpointercapture"));
    expect(locked()).toBe(false);
  });

  it("拖拽中组件卸载同样解锁", () => {
    const { app, divider } = mountPane();
    divider.dispatchEvent(pointer("pointerdown", { clientX: 160 }));
    expect(locked()).toBe(true);
    app.unmount();
    expect(locked()).toBe(false);
  });
});
