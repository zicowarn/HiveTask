// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import GanttPanel from "../src/panels/GanttPanel.vue";
import { useProjectsStore } from "../src/stores/projects";

// jsdom 没有 ResizeObserver（jordium 挂载时构造；WKWebView/Safari 13.1+ 原生支持，
// 仅测试环境需补空实现，避免 unhandled rejection 噪音）
if (!("ResizeObserver" in globalThis)) {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
}

/**
 * 甘特 Editor 实挂（渲染层 = jordium-gantt-vue3，2026-09-21 用户拍板引入）：
 * 断言面板把数据交给库并渲染出库的根节点；空态三档在本面板内自绘。
 * 库内部的条/箭头几何属库责任，不在本测试范围。
 */
describe("甘特面板（jordium 渲染）", () => {
  it("有条目与日期字段时渲染 jordium 画布，且无空态", async () => {
    const pinia = createPinia();
    const app = createApp(GanttPanel);
    app.use(pinia);
    const host = document.createElement("div");
    document.body.appendChild(host);
    app.mount(host);
    const store = useProjectsStore(pinia);
    store.selectedId = "pj1";
    store.fields = [
      { id: "f_start", projectId: "pj1", kind: "date", name: "Start", options: [], position: 0 },
      { id: "f_end", projectId: "pj1", kind: "date", name: "End", options: [], position: 1 },
    ];
    store.items = [
      {
        id: "it1", projectId: "pj1", kind: "issue", repoId: "r1", number: "1",
        draftTitle: null, draftBody: null, rank: "a", addedAt: "2026-09-19T00:00:00Z",
        repoLabel: "repoA", ghost: false, entity: null,
        fieldValues: { f_start: "2026-05-10", f_end: "2026-05-14" },
      },
    ] as never;
    await nextTick();
    await nextTick();

    expect(host.querySelector(".gt-empty")).toBeNull();
    expect(host.querySelector(".gt-toolbar")).toBeTruthy();
    // jordium 的根节点（库自带类名，实证自 dist）
    expect(host.querySelector(".gantt-root")).toBeTruthy();
    // 主题变量映射：容器上应挂我们覆盖后的 --gantt-* 值（css 变量不在此断言计算值，
    // 只锁容器存在——映射正确性靠样式审查 + 实机验证）
    expect(host.querySelector(".gt-jordium")).toBeTruthy();
    app.unmount();
    host.remove();
  });

  it("无日期字段时给引导态（不渲染画布）", async () => {
    const pinia = createPinia();
    const app = createApp(GanttPanel);
    app.use(pinia);
    const host = document.createElement("div");
    document.body.appendChild(host);
    app.mount(host);
    const store = useProjectsStore(pinia);
    store.selectedId = "pj1";
    store.fields = [];
    store.items = [];
    await nextTick();
    expect(host.querySelector(".gantt-root")).toBeNull();
    expect(host.querySelector(".gt-empty")).toBeTruthy();
    app.unmount();
    host.remove();
  });

  /** 回归（2026-09-21 用户实测）：首版甘特是裸 div，没套 PanelShell——
   *  切进来后没有 Editor 切换器、切不回去、也无法分栏/关闭。 */
  it("作为 Editor 面板渲染时必须带 PanelShell 外壳（切换器/分栏/关闭）", async () => {
    const pinia = createPinia();
    const app = createApp(GanttPanel, { leafId: "leaf-1", panelType: "project.gantt" });
    app.use(pinia);
    const host = document.createElement("div");
    document.body.appendChild(host);
    app.mount(host);
    const store = useProjectsStore(pinia);
    store.selectedId = "pj1";
    store.fields = [
      { id: "f1", projectId: "pj1", kind: "date", name: "Start", options: [], position: 0 },
    ];
    store.items = [];
    await nextTick();
    await nextTick();
    // 外壳存在：面板头 + Editor 切换器（能改回看板）
    expect(host.querySelector(".panel-header")).toBeTruthy();
    expect(host.querySelector(".editor-switcher")).toBeTruthy();
    // 分栏/关闭控件同属外壳
    expect(host.querySelector(".layout-actions")).toBeTruthy();
    // Mode 标签（任务/资源/负载）——2026-09-21 拆分后必须可见且可切换
    const tabs = host.querySelectorAll(".mode-tab");
    expect(tabs.length).toBe(3); // 任务 / 资源 / 负载
    expect([...tabs].every((b) => (b.textContent ?? "").trim().length > 0)).toBe(true);
    expect(host.querySelector(".mode-tab.active")).toBeTruthy();
    app.unmount();
    host.remove();
  });
});
