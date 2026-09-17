// @vitest-environment jsdom
/**
 * ⌘P 面板接线：列出文件、键盘上下选、回车打开、esc 关闭、最近打开优先。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { waitForDom } from "./test-support";

const FILES = ["note.md", "docs/note-deep.md", "readme.md", "src/main.ts"];
const walkCalls: number[] = [];

vi.mock("../src/api", () => ({
  isTauri: () => false,
  api: {
    kbWalk: async () => {
      walkCalls.push(1);
      return FILES;
    },
    kbListDir: async () => [],
    kbStat: async () => ({ exists: true, kind: "file", size: 1, mtimeMs: 1 }),
  },
}));

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
  walkCalls.length = 0;
});

beforeAll(async () => {
  const { useI18n } = await import("../src/i18n");
  useI18n().setLocale("zh-CN");
});

async function mountPalette() {
  const { useKnowledgeStore } = await import("../src/stores/knowledge");
  const { default: KnowledgeQuickOpen } = await import("../src/knowledge/KnowledgeQuickOpen.vue");
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useKnowledgeStore();
  store.root = "/tmp/kb";
  const closed = { count: 0 };
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp(KnowledgeQuickOpen, { onClose: () => (closed.count += 1) });
  apps.push(app);
  app.use(pinia);
  app.mount(host);
  await nextTick();
  return { host, store, closed };
}

describe("⌘P 面板", () => {
  it("空查询列出全部文件（最近打开置顶），一次 kb_walk", async () => {
    const { host } = await mountPalette();
    await waitForDom(() => {
      expect(host.querySelectorAll(".qo-row").length).toBe(FILES.length);
    });
    expect(walkCalls.length, "文件清单只遍历一次（缓存）").toBe(1);
  });

  it("输入即过滤，↑↓ 改选中，回车打开该文件", async () => {
    const { host, store } = await mountPalette();
    await waitForDom(() => expect(host.querySelectorAll(".qo-row").length).toBe(FILES.length));

    const input = host.querySelector<HTMLInputElement>(".qo-input")!;
    input.value = "note";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForDom(() => {
      const names = [...host.querySelectorAll(".qo-name")].map((el) => el.textContent);
      expect(names).toEqual(["note.md", "note-deep.md"]);
    });

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    expect(store.selected, "回车打开的是第 2 项").toBe("docs/note-deep.md");
    // 打开过就进最近列表（下次 ⌘P 置顶）
    expect(store.recentFiles[0]).toBe("docs/note-deep.md");
  });

  it("esc 关闭面板", async () => {
    const { host, closed } = await mountPalette();
    host.querySelector<HTMLInputElement>(".qo-input")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await nextTick();
    expect(closed.count).toBe(1);
  });
});

describe("菜单/快捷键 → 面板（全局入口）", () => {
  it("store 下发 quickOpen：面板打开快速打开条", async () => {
    vi.resetModules();
    const { createApp, h, nextTick } = await import("vue");
    const { useI18n } = await import("../src/i18n");
    useI18n().setLocale("zh-CN");
    const { default: KnowledgeWorkbench } = await import("../src/knowledge/KnowledgeWorkbench.vue");
    const { useKnowledgeStore } = await import("../src/stores/knowledge");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useKnowledgeStore();
    store.root = "/tmp/kb";
    store.children = { "": [] } as never;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(KnowledgeWorkbench, {}) });
    app.use(pinia);
    app.mount(host);
    await nextTick();

    expect(host.querySelector(".qo"), "默认不该有快速打开条").toBeNull();
    // 菜单/全局快捷键下发命令（App.vue 走的就是这条）
    store.runCommand("quickOpen");
    await waitForDom(() => {
      expect(host.querySelector(".qo"), "下发 quickOpen 后应打开").not.toBeNull();
    });
    expect(store.pendingCommand, "命令消费后要清零").toBeNull();

    app.unmount();
    host.remove();
  });

  it("store 下发 search：左栏切到搜索视图", async () => {
    vi.resetModules();
    const { createApp, h, nextTick } = await import("vue");
    const { useI18n } = await import("../src/i18n");
    useI18n().setLocale("zh-CN");
    const { default: KnowledgeWorkbench } = await import("../src/knowledge/KnowledgeWorkbench.vue");
    const { useKnowledgeStore } = await import("../src/stores/knowledge");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useKnowledgeStore();
    store.root = "/tmp/kb";
    store.children = { "": [] } as never;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(KnowledgeWorkbench, {}) });
    app.use(pinia);
    app.mount(host);
    await nextTick();

    store.runCommand("search");
    await waitForDom(() => {
      expect(host.querySelector(".kb-search"), "应切到搜索视图").not.toBeNull();
    });

    app.unmount();
    host.remove();
  });
});
