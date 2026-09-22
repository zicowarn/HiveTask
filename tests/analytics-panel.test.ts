// @vitest-environment jsdom
/**
 * 项目分析面板（Q9 燃起图）：守两件事——
 * ① 组件表真的注册了（元数据齐了但忘 registerPanel = 弹层能选中、面板渲染不出来）；
 * ② 打开面板时**先刷新当天快照再读**（用户看到的"今天"是到此刻为止，不是上次采集值）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";

const calls: string[] = [];
let SNAPSHOTS = [
  { day: "2026-09-20", total: 4, status: { todo: 2, done: 2 }, labels: { todo: "Todo", done: "Done" } },
  { day: "2026-09-21", total: 6, status: { todo: 3, done: 3 }, labels: { todo: "Todo", done: "Done" } },
];

const PROJECT = { id: "p1", displayName: "看板", description: null, connectionId: null, archived: false };

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {
    // selected 由「项目列表 ∋ selectedId」派生——空的列表会让面板退到"先选一个项目"
    projectList: async () => [PROJECT],
    projectSnapshotTake: async (id: string) => {
      calls.push(`take:${id}`);
      return { day: "2026-09-21", total: 6, status: {}, labels: {} };
    },
    projectSnapshotList: async (id: string, days: number) => {
      calls.push(`list:${id}:${days}`);
      return SNAPSHOTS;
    },
  },
}));

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
  calls.length = 0;
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}

beforeAll(async () => {
  const { useI18n } = await import("../src/i18n");
  useI18n().setLocale("zh-CN");
});

async function mountPanel(): Promise<HTMLElement> {
  setActivePinia(createPinia());
  const { useProjectsStore } = await import("../src/stores/projects");
  const store = useProjectsStore();
  await store.loadProjects();
  store.select("p1");
  const { default: ProjectAnalyticsPanel } = await import("../src/panels/ProjectAnalyticsPanel.vue");
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp(ProjectAnalyticsPanel, { panelType: "project.analytics" });
  apps.push(app);
  app.mount(host);
  await flush();
  return host;
}

describe("项目分析面板", () => {
  it("组件表已注册", async () => {
    const { resolvePanel } = await import("../src/workbench/registry");
    expect(resolvePanel("project.analytics")?.component, "应已注册组件").toBeTruthy();
  });

  it("打开即刷新当天快照，再按窗口读取历史", async () => {
    const host = await mountPanel();
    expect(calls[0], "先 take（当天值 = 到此刻）").toBe("take:p1");
    expect(calls[1]).toBe("list:p1:30");
    // 图出来了（SVG 有 path，且不是空图）
    expect(host.querySelectorAll("svg path").length).toBeGreaterThan(0);
  });

  it("只有一条快照时如实说明（点少画不成线），且单点画成当日柱", async () => {
    SNAPSHOTS = [{ day: "2026-09-21", total: 1, status: { todo: 1 }, labels: { todo: "Todo" } }];
    const host = await mountPanel();
    expect(host.textContent).toContain("窗口内记录还很少");
    // 横轴是窗口本身（空区域也有范围），且有"记录起点"虚线
    expect(host.querySelector(".an-start"), "起点标记").toBeTruthy();
    // 单点 → 当日柱（rect），不是什么都看不见的空画布
    expect(host.querySelectorAll("svg rect").length).toBeGreaterThan(0);
    expect(host.querySelector("svg text")?.textContent, "柱顶标总数").toBe("1");
  });

  it("横轴刻度标的是窗口范围（不是数据的首尾）", async () => {
    SNAPSHOTS = [{ day: "2026-09-22", total: 2, status: { todo: 2 }, labels: { todo: "Todo" } }];
    const host = await mountPanel();
    const labels = [...host.querySelectorAll(".an-xlabel")].map((e) => e.textContent);
    expect(labels, "首/中/尾三个窗口刻度").toHaveLength(3);
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(labels[2], "最右 = 今天").toBe(`${pad(today.getMonth() + 1)}-${pad(today.getDate())}`);
  });
});
