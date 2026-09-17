// @vitest-environment jsdom
/**
 * 全文搜索浮层：命中分组、跳转请求、选中不关面板、以及"防抖只为最后一次输入发一次"。
 *
 * 搜索本体在 Rust（编码探测后才匹配，GBK 中文也搜得到），这里验的是**接线**：
 * 点击命中要落到"打开文件 + 跳到那一行"这条链上。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { waitForDom } from "./test-support";

const hits = ref<{ rel: string; line: number; column: number; text: string }[]>([]);
const searchCalls: string[] = [];

vi.mock("../src/api", () => ({
  isTauri: () => false,
  api: {
    kbSearch: async (_root: string, query: string) => {
      searchCalls.push(query);
      return { hits: hits.value, files: new Set(hits.value.map((hit) => hit.rel)).size, truncated: false };
    },
    kbWalk: async () => [],
  },
}));

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
  searchCalls.length = 0;
});

beforeAll(async () => {
  const { useI18n } = await import("../src/i18n");
  useI18n().setLocale("zh-CN");
});

async function mountSearch() {
  const { useKnowledgeStore } = await import("../src/stores/knowledge");
  const { default: KnowledgeSearchPalette } = await import("../src/knowledge/KnowledgeSearchPalette.vue");
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useKnowledgeStore();
  store.root = "/tmp/kb";
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp({ render: () => h(KnowledgeSearchPalette, { onClose: () => {} }) });
  apps.push(app);
  app.use(pinia);
  app.mount(host);
  await nextTick();
  return { host, store };
}

describe("全文搜索接线", () => {
  it("按文件分组，点击命中 → 打开该文件并请求跳到那一行", async () => {
    hits.value = [
      { rel: "docs/a.md", line: 12, column: 3, text: "这里有命中" },
      { rel: "docs/a.md", line: 30, column: 1, text: "又一次命中" },
      { rel: "b.txt", line: 4, column: 2, text: "另一个文件" },
    ];
    const { host, store } = await mountSearch();
    const input = host.querySelector<HTMLInputElement>(".sp-input")!;
    input.value = "命中";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    // 输入防抖 220ms
    await waitForDom(() => {
      expect(host.querySelectorAll(".sp-group").length, "两个文件 → 两组").toBe(2);
    });
    expect(host.querySelector(".sp-summary")!.textContent).toContain("3 条命中");

    const hit = host.querySelectorAll<HTMLElement>(".sp-hit")[1];
    hit.click();
    await nextTick();
    expect(store.selected, "应打开命中所在文件").toBe("docs/a.md");
    expect(store.jumpToLine, "应请求跳到第 30 行").toEqual({ rel: "docs/a.md", line: 30 });
    // 与 ⌘P 的区别：搜索**选中后不关面板**（要能一边看正文一边逐条点）
    expect(host.querySelector(".sp"), "面板应保持打开").not.toBeNull();
    expect(host.querySelectorAll(".sp-hit.on").length, "当前命中应被标出").toBe(1);
  });

  it("清空查询不发请求；防抖只为最后一次输入发一次", async () => {
    hits.value = [{ rel: "a.md", line: 1, column: 1, text: "x" }];
    const { host } = await mountSearch();
    const input = host.querySelector<HTMLInputElement>(".sp-input")!;
    for (const value of ["河", "河南", "河南神马"]) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await waitForDom(() => {
      expect(searchCalls.length, "连续输入只该发最后一次").toBe(1);
    });
    expect(searchCalls[0]).toBe("河南神马");
  });
});
