// @vitest-environment jsdom
/**
 * Editor 切换器弹层的**逃逸与落点**：分栏工作台里左栏较窄时，弹层若留在面板
 * 子树内，会被 `.pane` 的 overflow 裁掉（用户实测：右半被右栏切在半字上）。
 * 守三件事——
 * ① 弹层 Teleport 到 body（不在任何会裁它的容器里）且 position: fixed；
 * ② 落点按触发器算：右边缘夹在视口内、下方放不下时向上翻；
 * ③ 外点关闭 / 点弹层内条目不关——Teleport 之后这两条都靠 ref 判包含关系。
 * jsdom 没有布局引擎，矩形与尺寸都打桩，断言的是**算出来的落点**这一层
 * （同 action-menu-anchor 的分层）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import EditorSwitcher from "../src/workbench/EditorSwitcher.vue";

const apps: App[] = [];
/** 被覆盖的原生尺寸描述符：桩用完要还回去（jsdom 的 getter 还回去才有默认 0）。 */
const metricDescriptors = new Map<string, PropertyDescriptor | undefined>();

function stubMetric(prop: "offsetWidth" | "offsetHeight", value: number): void {
  if (!metricDescriptors.has(prop)) {
    metricDescriptors.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
  }
  Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
}

afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  document.body.querySelectorAll(".switcher-pop").forEach((el) => el.remove());
  for (const [prop, descriptor] of metricDescriptors) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  }
  metricDescriptors.clear();
  vi.restoreAllMocks();
});

const TRIGGER_WIDTH = 120;
const TRIGGER_HEIGHT = 22;

/** 挂载并打开弹层；桩必须在挂载前打好（组件打开时先量尺寸再定位）。 */
async function mountSwitcher(opts: {
  triggerLeft: number;
  triggerTop: number;
  popWidth: number;
  popHeight: number;
}) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: opts.triggerLeft,
    y: opts.triggerTop,
    left: opts.triggerLeft,
    top: opts.triggerTop,
    right: opts.triggerLeft + TRIGGER_WIDTH,
    bottom: opts.triggerTop + TRIGGER_HEIGHT,
    width: TRIGGER_WIDTH,
    height: TRIGGER_HEIGHT,
    toJSON: () => ({}),
  } as DOMRect);
  stubMetric("offsetWidth", opts.popWidth);
  stubMetric("offsetHeight", opts.popHeight);

  const changes: string[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp({
    render: () =>
      h(EditorSwitcher, {
        panelType: "issue.list",
        onChange: (value: string) => changes.push(value),
      }),
  });
  apps.push(app);
  app.mount(host);
  await nextTick();
  host.querySelector<HTMLButtonElement>(".switcher-btn")!.click();
  await nextTick();
  await nextTick();
  return { host, changes };
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
}

describe("Editor 切换器弹层", () => {
  it("挂在 body 上，不在会被面板 overflow 裁掉的容器内", async () => {
    setViewport(1200, 800);
    const { host } = await mountSwitcher({
      triggerLeft: 40,
      triggerTop: 100,
      popWidth: 424,
      popHeight: 240,
    });
    const pop = document.body.querySelector<HTMLElement>(".switcher-pop");
    expect(pop).not.toBeNull();
    // 组件子树（挂载点）里没有它 = 分栏时不会被 pane 的 overflow 切掉右半
    expect(host.querySelector(".switcher-pop")).toBeNull();
    expect(pop!.parentElement).toBe(document.body);
    expect(pop!.style.position).toBe("fixed");
  });

  it("空间充足：落在触发器正下方", async () => {
    setViewport(1200, 800);
    await mountSwitcher({ triggerLeft: 40, triggerTop: 100, popWidth: 424, popHeight: 240 });
    const pop = document.body.querySelector<HTMLElement>(".switcher-pop")!;
    expect(pop.style.left).toBe("40px");
    expect(pop.style.top).toBe("127px"); // top 100 + 触发器高 22 + 间隙 5
    expect(pop.style.bottom).toBe("auto");
  });

  it("右边缘空间不足：向左夹取，不越出视口", async () => {
    setViewport(400, 800);
    await mountSwitcher({ triggerLeft: 380, triggerTop: 100, popWidth: 300, popHeight: 240 });
    const pop = document.body.querySelector<HTMLElement>(".switcher-pop")!;
    expect(pop.style.left).toBe("94px"); // 400 - 300（弹层宽）- 6（边距）
    expect(parseFloat(pop.style.left) + 300).toBeLessThanOrEqual(400);
  });

  it("下方空间不足：向上翻，不被窗口下沿切掉", async () => {
    setViewport(1200, 600);
    await mountSwitcher({ triggerLeft: 40, triggerTop: 520, popWidth: 424, popHeight: 240 });
    const pop = document.body.querySelector<HTMLElement>(".switcher-pop")!;
    expect(pop.style.bottom).toBe("85px"); // 600 - 触发器顶 520 + 间隙 5
    expect(pop.style.top).toBe("auto");
  });

  it("外点关闭，点弹层内条目不关（挑中即切换并收起）", async () => {
    setViewport(1200, 800);
    const { changes } = await mountSwitcher({
      triggerLeft: 40,
      triggerTop: 100,
      popWidth: 424,
      popHeight: 240,
    });

    // 弹层内的条目：pointerdown 不得被当成外点（Teleport 后不再在触发器的 DOM 子树里）
    const items = document.body.querySelectorAll<HTMLButtonElement>(".editor-item");
    // 分类顺序 Issues → …：第二项是 Issue 详情
    expect(items.length).toBeGreaterThan(1);
    const second = items[1]!;
    second.click();
    await nextTick();
    expect(changes).toEqual(["issue.detail"]);
    expect(document.body.querySelector(".switcher-pop")).toBeNull();
  });

  it("点弹层之外收起", async () => {
    setViewport(1200, 800);
    const { host } = await mountSwitcher({
      triggerLeft: 40,
      triggerTop: 100,
      popWidth: 424,
      popHeight: 240,
    });
    expect(document.body.querySelector(".switcher-pop")).not.toBeNull();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await nextTick();
    expect(document.body.querySelector(".switcher-pop")).toBeNull();
    expect(host.querySelector(".switcher-btn")).not.toBeNull();
  });
});
