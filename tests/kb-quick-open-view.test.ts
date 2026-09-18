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

  it("store 下发 search：弹出搜索浮层", async () => {
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
      expect(host.querySelector(".sp"), "应弹出搜索浮层").not.toBeNull();
    });

    app.unmount();
    host.remove();
  });
});

describe("编码切换（状态栏 → 面板）", () => {
  const mount = async (rel: string) => {
    vi.resetModules();
    const { createApp } = await import("vue");
    const { useI18n } = await import("../src/i18n");
    useI18n().setLocale("zh-CN");
    const reads: (string | undefined)[] = [];
    vi.doMock("../src/api", () => ({
      isTauri: () => true,
      api: {
        kbStat: async () => ({ exists: true, kind: "file", size: 8, mtimeMs: 1 }),
        kbReadText: async (_root: string, _rel: string, encoding?: string) => {
          reads.push(encoding);
          return {
            text: `按 ${encoding ?? "自动"} 解码`,
            encoding: encoding ?? "GBK",
            bom: false,
            eol: "\n",
            size: 8,
            mtimeMs: 1,
          };
        },
        kbReadBytes: async () => new ArrayBuffer(8),
        kbListDir: async () => [],
        kbWalk: async () => [],
      },
    }));
    const { default: KnowledgePreview } = await import("../src/knowledge/KnowledgePreview.vue");
    const { useKnowledgeStore } = await import("../src/stores/knowledge");
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useKnowledgeStore();
    store.root = "/tmp/kb";
    store.selected = rel;

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(KnowledgePreview);
    app.use(pinia);
    app.mount(host);
    // 等初次加载真正完成（否则初次读取会与切换竞争，测不准）
    await waitForDom(() => {
      expect(reads.length, "初次加载应读一次").toBe(1);
    });
    return { host, store, reads, app };
  };

  it("Markdown：切换后正文与缓冲都按新编码（保存将按新编码写回）", async () => {
    const { host, store, reads, app } = await mount("a.md");
    expect(store.activeText?.encoding, "自动探测结果显示在状态栏").toBe("GBK");

    store.requestEncoding("UTF-8");
    await waitForDom(() => {
      expect(reads, "应带 UTF-8 参数重读").toContain("UTF-8");
    });
    expect(store.encodingRequest, "消费后清零").toBeNull();
    expect(store.activeText?.encoding).toBe("UTF-8");
    expect(store.buffers["a.md"]?.text).toContain("按 UTF-8 解码");
    app.unmount();
    host.remove();
    vi.doUnmock("../src/api");
  });

  it("文本/代码（注册表渲染）：切换后**画面真的重渲染**，状态栏编码也跟着更新", async () => {
    // 这条是先前漏掉的路径：`.txt` 由注册表的 text 插件画成 <pre class="kb-code">，
    // 只更新 text.value 不会重画——用户实测"没有实现"就是这里。
    const { host, store, reads, app } = await mount("遗留GBK.txt");
    await waitForDom(() => {
      expect(host.querySelector(".kb-code"), "txt 应由 text 插件渲染").not.toBeNull();
    });
    // 状态栏的编码格依赖 activeText：空壳会让它整格消失，用户就没有入口可点
    expect(store.activeText?.encoding, "注册表路径也要回灌真实编码").toBe("GBK");

    store.requestEncoding("UTF-8");
    await waitForDom(() => {
      expect(host.querySelector(".kb-code")?.textContent, "画面应按新编码重画").toContain("按 UTF-8 解码");
    });
    expect(store.activeText?.encoding).toBe("UTF-8");
    expect(reads.filter((item) => item === "UTF-8").length, "切换只触发一次重读").toBe(1);

    // 手动编码只作用于它被指定的文件：切到别的文件必须回到自动探测
    store.selected = "另一个.txt";
    await waitForDom(() => {
      expect(reads.at(-1), "换文件后应回到自动探测").toBeUndefined();
    });
    app.unmount();
    host.remove();
    vi.doUnmock("../src/api");
  });
});
