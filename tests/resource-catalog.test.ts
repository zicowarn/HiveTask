// @vitest-environment jsdom
/**
 * 资源目录搬去「项目」工作区（用户定案 2026-09-22）：「资源目录应该单独做个 Editor，
 * 放在『项目』工作区中」——搬移类改动必须验**两端**：设置里控件本体已不在，
 * 新 Editor 能真的用（列表、新建、行内改名、两击删除）。
 *
 * 顺带守左移对齐的机制：日历订阅与数据备份两个顶层区块必须带 `top-level`
 * （去掉子区块的 16px 缩进，左缘与 setting-row 一致）；「按扩展名指定」是
 * 「打开方式」的子明细，保持缩进不动。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";

const upserted: unknown[] = [];
const removed: string[] = [];

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {
    resourceList: async () => [
      { id: "r1", name: "张三", title: "前端", type: "Human", capacity: 8, origin: null },
      { id: "gh-gh-zhaosi", name: "赵四", title: null, type: "Human", capacity: null, origin: "gh" },
    ],
    resourceUpsert: async (r: unknown) => {
      upserted.push(r);
    },
    resourceRemove: async (id: string) => {
      removed.push(id);
    },
    itemResourceList: async () => [],
    // 设置面板 onMounted 会打到这些（各有 try/catch，给空实现避免噪音）
    kbOpenPrefsGet: async () => ({ byExt: {} }),
    kbOpenPrefsSet: async () => {},
    kbAppsList: async () => [],
    kbAppsForExt: async () => ({ default: null, candidates: [] }),
    connectionList: async () => [],
    backupStatus: async () => ({ dir: "/tmp/b", count: 0, latest: null }),
    calendarFeedList: async () => [],
    ghAuthUser: async () => null,
  },
}));

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
  upserted.length = 0;
  removed.length = 0;
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

async function mountPanel(): Promise<HTMLElement> {
  setActivePinia(createPinia());
  const { default: ProjectResourcesPanel } = await import("../src/panels/ProjectResourcesPanel.vue");
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp(ProjectResourcesPanel, { panelType: "project.resources" });
  apps.push(app);
  app.mount(host);
  await flush();
  return host;
}

async function mountSettings(): Promise<HTMLElement> {
  setActivePinia(createPinia());
  const { default: SettingsBasicMode } = await import("../src/panels/modes/SettingsBasicMode.vue");
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp(SettingsBasicMode);
  apps.push(app);
  app.mount(host);
  await flush();
  return host;
}

describe("资源目录：从设置搬到「项目」工作区的 Editor", () => {
  it("组件表已注册（元数据齐了但忘了 registerPanel = 弹层能选中、面板渲染不出来）", async () => {
    const { resolvePanel } = await import("../src/workbench/registry");
    expect(resolvePanel("project.resources")?.component, "应已注册组件").toBeTruthy();
  });

  it("设置面板里已无资源目录（控件本体搬走，不是改文案）", async () => {
    const host = await mountSettings();
    const text = host.textContent ?? "";
    expect(text).not.toContain("资源目录");
    expect(text).not.toContain("新建资源");
    // 资源行特有的两个输入框（名称 / 日容量）也应消失
    expect(host.querySelectorAll('input[placeholder="资源名称"]')).toHaveLength(0);
    expect(host.querySelectorAll('input[placeholder="日容量(h)"]')).toHaveLength(0);
  });

  it("两个顶层区块带 top-level（左缘与 setting-row 对齐），子明细保持缩进", async () => {
    const host = await mountSettings();
    const blocks = [...host.querySelectorAll<HTMLElement>(".setting-byext")];
    const topLevel = blocks.filter((b) => b.classList.contains("top-level"));
    expect(topLevel, "日历订阅 + 数据备份 = 2 个顶层区块").toHaveLength(2);
    // 「按扩展名指定」是「打开方式」的子明细——不得被拉平
    const byExt = blocks.find((b) => b.textContent?.includes("按扩展名指定"));
    expect(byExt && !byExt.classList.contains("top-level")).toBe(true);
  });

  it("新 Editor 列出资源目录：本地与平台来源分别标注", async () => {
    const host = await mountPanel();
    const rows = [...host.querySelectorAll<HTMLElement>(".rc-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector<HTMLInputElement>("input.rc-name")?.value).toBe("张三");
    expect(rows[0].textContent).toContain("本地");
    expect(rows[1].textContent).toContain("平台·gh");
  });

  it("新建：占位行填名回车 → 落库为本地资源（origin null，id 本地前缀）", async () => {
    const host = await mountPanel();
    const add = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("新建资源"),
    );
    add!.click();
    await flush();
    const draft = host.querySelector<HTMLInputElement>(".rc-row:last-of-type input.rc-name");
    expect(draft, "应出现占位行").toBeTruthy();
    draft!.value = "李四";
    draft!.dispatchEvent(new Event("input"));
    draft!.dispatchEvent(new Event("keydown")); // 回车路径由 v-model + blur 提交
    draft!.dispatchEvent(new Event("blur"));
    await flush();

    expect(upserted).toHaveLength(1);
    const row = upserted[0] as { name: string; type: string; origin: string | null; id: string };
    expect(row.name).toBe("李四");
    expect(row.type).toBe("Human");
    expect(row.origin).toBeNull();
    expect(row.id.startsWith("local-")).toBe(true);
  });

  it("行内改名即存；删除走两击确认", async () => {
    const host = await mountPanel();
    const nameInput = host.querySelector<HTMLInputElement>(".rc-row input.rc-name")!;
    nameInput.value = "张三丰";
    nameInput.dispatchEvent(new Event("input"));
    nameInput.dispatchEvent(new Event("blur"));
    await flush();
    expect((upserted.at(-1) as { name: string }).name).toBe("张三丰");

    const del = [...host.querySelectorAll<HTMLButtonElement>(".rc-remove")][0];
    del.click();
    await flush();
    expect(removed, "第一击只上膛").toHaveLength(0);
    del.click();
    await flush();
    expect(removed).toEqual(["r1"]);
  });
});
