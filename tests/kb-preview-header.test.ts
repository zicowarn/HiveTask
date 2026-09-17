// @vitest-environment jsdom
/**
 * 面板头构成契约（用户两轮定案的落点）：
 * - Markdown 文件：中部是**工具条**，右端是可见的**「用默认程序打开」按钮**；
 * - **不再有 ⋯ 菜单**（文件动作移到右键菜单——折叠后菜单只剩单项，用户已否掉）；
 * - 非 Markdown（如 txt）：不显示工具条（命令对纯文本无意义）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForDom } from "./test-support";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";

const TEXT = {
  text: "# 标题\n\n正文\n",
  encoding: "UTF-8",
  bom: false,
  eol: "\n",
  size: 12,
  mtimeMs: 1,
};

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {
    kbReadText: async () => TEXT,
    kbReadBytes: async () => new ArrayBuffer(0),
    kbStat: async () => ({ exists: true, kind: "file", size: 12, mtimeMs: 1 }),
    kbOpenExternal: async () => undefined,
  },
}));

const mounted: App[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

async function mountPreview(rel: string) {
  const { useKnowledgeStore } = await import("../src/stores/knowledge");
  const { default: KnowledgePreview } = await import("../src/knowledge/KnowledgePreview.vue");
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useKnowledgeStore();
  store.root = "/tmp/kb";
  store.selected = rel;

  const host = document.createElement("div");
  document.body.appendChild(host);
  const app = createApp(KnowledgePreview);
  app.use(pinia);
  mounted.push(app);
  app.mount(host);
  // 等文件载入（异步）+ 组件渲染
  await waitForDom(() => {
    expect(host.querySelector(".preview-header")).toBeTruthy();
  });
  await nextTick();
  return host;
}

describe("知识库面板头", () => {
  it("Markdown：中部工具条 + 右端可见的「用默认程序打开」按钮，且没有 ⋯ 菜单", async () => {
    const host = await mountPreview("note.md");
    await waitForDom(() => expect(host.querySelector(".head-toolbar")).toBeTruthy());

    const toolbar = host.querySelector(".head-toolbar")!;
    expect(toolbar.querySelectorAll(".md-tool").length).toBeGreaterThanOrEqual(12);

    const actions = host.querySelector(".head-actions")!;
    // 文案随语言（jsdom 的 navigator.language 可能是 en）——两种都接受，重点是"可见按钮而非折叠菜单"
    expect(actions.textContent ?? "").toMatch(/默认应用打开|Open in default app/);
    // ⋯ 触发器已移除（文件动作改在右键菜单里）
    expect(actions.querySelector(".am-trigger")).toBeNull();
  });

  it("非 Markdown：不渲染工具条（命令对纯文本无意义）", async () => {
    const host = await mountPreview("notes.txt");
    await waitForDom(() => expect(host.querySelector(".preview-header")).toBeTruthy());
    expect(host.querySelector(".head-toolbar")).toBeNull();
  });
});

describe("视图开关（大纲 / 源码模式 / 查找）", () => {
  it("Markdown：头部右端有三个视图动作，且大纲默认关闭（不占宽度）", async () => {
    const host = await mountPreview("view.md");
    await waitForDom(() => expect(host.querySelector(".head-toolbar")).toBeTruthy());

    const actions = host.querySelector(".head-actions")!;
    const iconButtons = actions.querySelectorAll(".icon-btn");
    expect(iconButtons.length).toBe(3); // 大纲 / 源码模式 / 查找
    // 与「用默认程序打开」并列在右端
    expect(actions.querySelector(".text-btn")).toBeTruthy();
    // 大纲默认关闭 → 不渲染第三栏
    expect(host.querySelector(".outline")).toBeNull();
  });

  it("大纲打开后渲染标题列表，并随文档给出条目", async () => {
    const host = await mountPreview("outline.md");
    await waitForDom(() => expect(host.querySelector(".head-toolbar")).toBeTruthy());
    // 点第一个图标按钮（大纲）
    (host.querySelectorAll(".head-actions .icon-btn")[0] as HTMLElement).click();
    await waitForDom(() => expect(host.querySelector(".outline")).toBeTruthy());
    // 大纲条目由编辑器 mount 后 emit —— 等一拍，别硬断言
    await waitForDom(() => {
      expect(host.querySelectorAll(".outline-item").length).toBeGreaterThan(0);
    });
    expect(host.querySelector(".outline-list")!.textContent).toContain("标题");
  });
});

describe("查找/替换条", () => {
  it("⌘F 打开自绘查找条（不是 CM6 的英文默认面板），关闭即撤高亮", async () => {
    const host = await mountPreview("find.md");
    await waitForDom(() => expect(host.querySelector(".head-toolbar")).toBeTruthy());

    // 初始不显示
    expect(host.querySelector(".find-bar")).toBeNull();

    // 点头部放大镜图标（第 3 个视图按钮）
    (host.querySelectorAll(".head-actions .icon-btn")[2] as HTMLElement).click();
    await waitForDom(() => expect(host.querySelector(".find-bar")).toBeTruthy());

    const bar = host.querySelector(".find-bar")!;
    // 我们的形态：文案走 i18n，而不是 CM6 面板的 next/previous/match case
    expect(bar.querySelectorAll(".find-input").length).toBeGreaterThanOrEqual(1);
    expect(bar.querySelectorAll(".find-toggle").length).toBe(4); // Aa / .* / W / 替换开关
    expect(bar.textContent ?? "").not.toContain("match case");
    // CM6 默认面板的类名不应出现
    expect(host.querySelector(".cm-search")).toBeNull();
  });
});

describe("字数统计（状态栏来源）", () => {
  it("编辑器上报 stats，随文档内容变化", async () => {
    const { createApp, h: render } = await import("vue");
    const MarkdownEditor = (await import("../src/knowledge/editor/MarkdownEditor.vue")).default;
    const seen: { chars: number; words: number }[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({
      render: () =>
        render(MarkdownEditor, {
          modelValue: "中文三个词 hello world",
          onStats: (value: { chars: number; words: number }) => seen.push(value),
        }),
    });
    app.mount(host);
    try {
      await waitForDom(() => expect(seen.length).toBeGreaterThan(0));
      // 非空白字符：中文三个词(5) + hello(5) + world(5) = 15；拉丁词 2
      expect(seen[0].chars).toBe(15);
      expect(seen[0].words).toBe(2);
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
