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

  it("csv（表格插件读文本）：状态栏能拿到真实编码，切换后表格按新编码重画", async () => {
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
            text: "名称,数量\n" + (encoding ? "按选择编码" : "自动探测") + ",1\n",
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
    store.selected = "表格-GBK.csv";

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(KnowledgePreview);
    app.use(pinia);
    app.mount(host);
    await waitForDom(() => {
      expect(host.querySelector(".kb-sheet"), "csv 应出表格视图").not.toBeNull();
    });
    // 状态栏的编码格依赖 activeText：表格插件走文本通道后应拿到真实编码
    expect(store.activeText?.encoding, "csv 也要回灌编码给状态栏").toBe("GBK");

    store.requestEncoding("GB18030");
    await waitForDom(() => {
      const text = host.querySelector(".kb-sheet")!.textContent ?? "";
      expect(text, "表格应按新编码重画").toContain("按选择编码");
    });
    expect(store.activeText?.encoding).toBe("GB18030");
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

describe("头部编码菜单与「转换并另存为」", () => {
  const mountPreview = async (rel: string) => {
    vi.resetModules();
    const { createApp } = await import("vue");
    const { useI18n } = await import("../src/i18n");
    useI18n().setLocale("zh-CN");
    const writes: { rel: string; encoding: string; text: string }[] = [];
    const existing = new Set<string>();
    vi.doMock("../src/api", () => ({
      isTauri: () => true,
      api: {
        kbStat: async (_root: string, path: string) => ({ exists: existing.has(path), kind: "file", size: 8, mtimeMs: 1 }),
        kbReadText: async (_root: string, _rel: string, encoding?: string) => ({
          text: "名称,数量\n中文,1\n",
          encoding: encoding ?? "GBK",
          bom: false,
          eol: "\n",
          size: 8,
          mtimeMs: 1,
        }),
        kbWriteText: async (args: { rel: string; encoding: string; text: string }) => {
          writes.push({ rel: args.rel, encoding: args.encoding, text: args.text });
          return 1;
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
    await waitForDom(() => {
      expect(host.querySelector(".head-left .enc-chip"), "文件名后应出现可点的编码 chip").not.toBeNull();
    });
    return { host, store, writes, app, existing };
  };

  it("头部编码 chip 显示当前编码，点开是命令菜单（重新打开 / 转换另存为）", async () => {
    const { host, app } = await mountPreview("表格-GBK.csv");
    const button = host.querySelector<HTMLElement>(".head-left .enc-chip")!;
    expect(button.textContent?.trim(), "显示当前（自动探测的）编码").toBe("GBK");
    button.click();
    await waitForDom(() => {
      expect(document.querySelector(".am-menu"), "应弹出命令菜单").not.toBeNull();
    });
    const text = document.querySelector(".am-menu")!.textContent ?? "";
    expect(text).toContain("以此编码重新打开");
    expect(text).toContain("自动探测");
    expect(text).toContain("转换并另存为");
    document.querySelectorAll(".am-menu").forEach((el) => el.remove());
    app.unmount();
    host.remove();
    vi.doUnmock("../src/api");
  });

  it("转换另存为：按目标编码写新文件（原件不动），默认名带编码后缀", async () => {
    const { host, writes, app } = await mountPreview("表格-GBK.csv");
    host.querySelector<HTMLElement>(".head-left .enc-chip")!.click();
    await waitForDom(() => expect(document.querySelector(".am-menu")).not.toBeNull());
    const convert = [...document.querySelectorAll<HTMLElement>(".am-menu [role=menuitem]")].find((el) =>
      el.textContent?.includes("转换并另存为"),
    )!;
    convert.click();
    const dialog = await waitForDom(() => {
      expect(document.querySelector(".kb-panel"), "应弹出转换对话框").not.toBeNull();
    });
    void dialog;
    const nameInput = document.querySelector<HTMLInputElement>(".kb-panel .kb-input")!;
    expect(nameInput.value, "默认名带目标编码后缀，保留原后缀").toBe("表格-GBK-utf8.csv");
    // 目标编码默认 UTF-8（源是 GBK）
    const save = [...document.querySelectorAll<HTMLElement>(".kb-panel .text-btn")].find((el) =>
      el.textContent?.includes("另存为"),
    )!;
    save.click();
    await waitForDom(() => {
      expect(writes.length, "应写出一个新文件").toBe(1);
    });
    expect(writes[0].rel).toBe("表格-GBK-utf8.csv");
    expect(writes[0].encoding, "按目标编码写").toBe("UTF-8");
    expect(writes[0].text).toContain("中文");
    document.querySelectorAll(".kb-overlay").forEach((el) => el.remove());
    app.unmount();
    host.remove();
    vi.doUnmock("../src/api");
  });

  it("目标文件已存在 → 拒绝覆盖并提示改名", async () => {
    const { host, writes, app, existing } = await mountPreview("表格-GBK.csv");
    existing.add("表格-GBK-utf8.csv");
    host.querySelector<HTMLElement>(".head-left .enc-chip")!.click();
    await waitForDom(() => expect(document.querySelector(".am-menu")).not.toBeNull());
    [...document.querySelectorAll<HTMLElement>(".am-menu [role=menuitem]")]
      .find((el) => el.textContent?.includes("转换并另存为"))!
      .click();
    await waitForDom(() => expect(document.querySelector(".kb-panel")).not.toBeNull());
    [...document.querySelectorAll<HTMLElement>(".kb-panel .text-btn")]
      .find((el) => el.textContent?.includes("另存为"))!
      .click();
    await waitForDom(() => {
      expect(document.querySelector(".kb-panel .kb-error")?.textContent).toContain("已存在");
    });
    expect(writes.length, "不该覆盖已有文件").toBe(0);
    document.querySelectorAll(".kb-overlay").forEach((el) => el.remove());
    app.unmount();
    host.remove();
    vi.doUnmock("../src/api");
  });
});
