// @vitest-environment jsdom
/**
 * 未关联条目（设备包导入未命中 / 登记行被删）的收口：提示条 + 「重新关联」。
 *
 * 背景（2026-09-22 修）：导入到新设备时仓库按 origin_url 重解析，未命中此前会被写成
 * repo_id = NULL **且 origin 一起丢**——卡看着正常、点开是空的，也修不回来。现在
 * origin 快照落库，未关联有显式提示，登记来源仓库后一键回填（Rust `relink_origin_in`，
 * 归一化匹配见 cargo 测试）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";

const relinkCalls: string[] = [];
let relinkResult = 1;
let items: unknown[] = [];

function unlinkedItem(): unknown {
  return {
    id: "it1",
    projectId: "p1",
    kind: "issue",
    repoId: null,
    originUrl: "https://github.com/o/r",
    originType: "github",
    number: "42",
    draftTitle: null,
    draftBody: null,
    rank: "1024",
    addedAt: "2026-09-01T00:00:00Z",
    repoLabel: null,
    ghost: true,
    fieldValues: {},
  };
}

const project = { id: "p1", displayName: "看板", description: null, connectionId: null, archived: false };

// 注意：这几个 mock **必须返回稳定引用**——每次返回新数组/新对象会让
// store 的 watcher 认为数据变了而反复重载，看板里表现为「Maximum recursive
// updates exceeded」（测试环境假象，不是产品 bug）。items 由用例按需替换。
const FIELDS = [
  {
    id: "f-status",
    projectId: "p1",
    kind: "builtin_status",
    name: "Status",
    options: [{ id: "todo", name: "Todo", color: "#ccc" }],
    position: 0,
  },
];
const EMPTY: unknown[] = [];
const PROJECTS = [project];
const LABELS = {};

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {
    projectList: async () => PROJECTS,
    projectGet: async () => project,
    projectFields: async () => FIELDS,
    projectItemList: async () => items,
    projectRepoList: async () => EMPTY,
    projectFieldValues: async () => EMPTY,
    itemResourceList: async () => EMPTY,
    resourceList: async () => EMPTY,
    projectDepList: async () => EMPTY,
    projectParentList: async () => EMPTY,
    projectViewLabel: async () => LABELS,
    projectRelinkOrigin: async (projectId: string) => {
      relinkCalls.push(projectId);
      if (relinkResult > 0) items = [{ ...(unlinkedItem() as object), repoId: "r9", ghost: false }];
      return relinkResult;
    },
  },
}));

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
  relinkCalls.length = 0;
  relinkResult = 1;
  items = [];
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

beforeAll(async () => {
  const { useI18n } = await import("../src/i18n");
  useI18n().setLocale("zh-CN");
});

async function mountHint(): Promise<HTMLElement> {
  setActivePinia(createPinia());
  const { useProjectsStore } = await import("../src/stores/projects");
  const store = useProjectsStore();
  store.select("p1");
  const { default: ProjectUnlinkedHint } = await import("../src/panels/ProjectUnlinkedHint.vue");
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp(ProjectUnlinkedHint);
  apps.push(app);
  app.mount(host);
  await flush();
  await store.refreshSelected();
  await flush();
  return host;
}

function hint(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".pj-unlinked");
}

describe("未关联条目：提示条与重新关联", () => {
  it("有未关联条目时出提示条（计数 + 来源仓库），无则不出", async () => {
    items = [unlinkedItem()];
    const host = await mountHint();
    const bar = hint(host);
    expect(bar, "应有未关联提示条").toBeTruthy();
    expect(bar!.textContent).toContain("1 个条目未关联");
    expect(bar!.textContent).toContain("https://github.com/o/r");

    // 没有未关联条目 → 提示条消失
    items = [{ ...(unlinkedItem() as object), repoId: "r9", ghost: false }];
    const host2 = await mountHint();
    expect(hint(host2)).toBeNull();
  });

  it("点「重新关联」把当前项目交给回填命令，并把结果如实反馈（成功/找不到）", async () => {
    items = [unlinkedItem()];
    const host = await mountHint();
    const btn = hint(host)!.querySelector<HTMLButtonElement>(".pj-unlinked-btn");
    expect(btn, "应有点击入口").toBeTruthy();
    btn!.click();
    await flush();
    expect(relinkCalls).toEqual(["p1"]);
    // 回填成功后条目重载 → 提示条消失
    await flush();
    await flush();
    expect(hint(host), "挂上后提示条消失").toBeNull();

    // 找不到匹配登记仓库：命令返回 0，提示条留着（诚实，不假装修好）
    items = [unlinkedItem()];
    relinkResult = 0;
    const host2 = await mountHint();
    hint(host2)!.querySelector<HTMLButtonElement>(".pj-unlinked-btn")!.click();
    await flush();
    expect(relinkCalls, "两次点击都打到同一个项目").toEqual(["p1", "p1"]);
    expect(hint(host2), "没匹配上就继续提示").toBeTruthy();
  });
});
