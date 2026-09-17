// @vitest-environment jsdom
/**
 * 查找导航的回归测试。
 *
 * 用户实测的 bug：点「上一个/下一个」时**底部弹出 CM6 自带的英文搜索面板**。
 * 根因：CM6 的 `findNext/findPrevious` 由 `searchCommand` 包装，无有效查询时会
 * `openSearchPanel(view)`。所以我们自实现导航，并在这里钉死三条：
 *  ① 有查询 → 选中下一个/上一个命中；
 *  ② 无查询 → **什么都不做，也绝不出现 CM6 面板**（`.cm-search` 必须不存在）；
 *  ③ 到底/到顶会环绕。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, type App } from "vue";
import { EditorView } from "@codemirror/view";

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
});

interface EditorApi {
  setFindQuery: (c: { search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }) => void;
  findNext: () => boolean;
  findPrevious: () => boolean;
  findStatus: () => { total: number; current: number };
}

async function mount(doc: string) {
  const MarkdownEditor = (await import("../src/knowledge/editor/MarkdownEditor.vue")).default;
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  let api: EditorApi | null = null;
  // 用 render 函数形式挂载：只有 `h(..., { ref })` 才拿得到组件的 expose（对象式 props 的 ref 无效）
  const app = createApp({
    render: () =>
      h(MarkdownEditor, {
        modelValue: doc,
        ref: (instance: unknown) => {
          api = instance as EditorApi | null;
        },
      }),
  });
  apps.push(app);
  app.mount(host);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { host, api: api as unknown as EditorApi };
}

const query = { replace: "", caseSensitive: false, regexp: false, wholeWord: false };
const DOC = "苹果 香蕉 苹果 橘子 苹果\n";

describe("查找导航", () => {
  it("有查询时逐个命中，且不出现 CM6 默认面板", async () => {
    const { host, api } = await mount(DOC);
    api.setFindQuery({ ...query, search: "苹果" });
    expect(api.findStatus().total).toBe(3);

    api.findNext();
    expect(api.findStatus().current).toBe(1);
    api.findNext();
    expect(api.findStatus().current).toBe(2);
    api.findNext();
    expect(api.findStatus().current).toBe(3);
    // 到底环绕回第一个
    api.findNext();
    expect(api.findStatus().current).toBe(1);
    // 上一个环绕到最后一个
    api.findPrevious();
    expect(api.findStatus().current).toBe(3);

    // 关键回归：CM6 自带面板绝不能出现
    expect(host.querySelector(".cm-search")).toBeNull();
  });

  it("无查询时点导航：无事发生，且绝不弹出 CM6 面板", async () => {
    const { host, api } = await mount(DOC);
    api.setFindQuery({ ...query, search: "" });
    expect(api.findNext()).toBe(false);
    expect(api.findPrevious()).toBe(false);
    expect(host.querySelector(".cm-search")).toBeNull();
  });

  it("命中跳转会选中该匹配（不是只移动光标）", async () => {
    const { host, api } = await mount(DOC);
    api.setFindQuery({ ...query, search: "香蕉" });
    api.findNext();
    const view = EditorView.findFromDOM(host.querySelector(".cm-editor") as HTMLElement);
    expect(view).toBeTruthy();
    const sel = view!.state.selection.main;
    expect(view!.state.sliceDoc(sel.from, sel.to)).toBe("香蕉");
  });
});
