// @vitest-environment jsdom
/**
 * 编辑器**渲染**测试（jsdom）：把真实的一套扩展挂上去，断言 DOM 里真的有内容。
 *
 * 为什么需要：装饰器单测只验证"装饰算得对"，管不了"渲染出来是不是空的"——
 * 本轮就踩到一次「行号在、正文全空」的真机现象，需要能快速复现的关卡。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { waitForDom } from "./test-support";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { livePreview } from "../src/knowledge/editor/live-preview";
import { mathAndDiagram } from "../src/knowledge/editor/math-diagram";

const DOC = `# 表格与待办

| 列名 | 说明 | 数量 |
|:---|:---:|---:|
| 甲 | 左对齐 | 1 |
| 乙 | 居中 | 2 |

待办：

- [ ] 未完成项
- [x] 已完成项
- 普通项

---

行内 \`代码\` 与 **粗体** 混排，公式 $E = mc^2$。

\`\`\`mermaid
graph TD
  A[开始] --> B[结束]
\`\`\`
`;

let view: EditorView;
let host: HTMLElement;

beforeAll(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      extensions: [
        markdown({ extensions: [GFM] }),
        livePreview,
        mathAndDiagram(),
        keymap.of(defaultKeymap),
      ],
    }),
    parent: host,
  });
});

describe("编辑器渲染（jsdom）", () => {
  it("正文文本出现在 DOM 里（不是只有行号）", () => {
    const text = host.textContent ?? "";
    expect(text).toContain("表格与待办");
    expect(text).toContain("普通项");
    expect(text).toContain("行内");
  });

  // 说明：以下断言都用"等待式"（waitForDom，默认 6s）。并行 worker 争用时，CM6 的装饰/widom 挂载
  // 可能比断言晚一拍——等一小会儿是稳定的，硬断言会随机失败（本文件确实抖过一次）。

  it("表格渲染成真正的 table 元素", async () => {
    await waitForDom(() => {
      expect(host.querySelector(".cm-kb-table table")).toBeTruthy();
    });
    expect(host.querySelectorAll(".cm-kb-table th").length).toBe(3);
    expect(host.querySelectorAll(".cm-kb-table tbody tr").length).toBe(2);
  });

  it("待办渲染成复选框，已完成项为勾选态", async () => {
    await waitForDom(() => {
      expect(host.querySelectorAll(".cm-kb-task").length).toBe(2);
    });
    expect(host.querySelectorAll(".cm-kb-task")[1].getAttribute("aria-checked")).toBe("true");
  });

  it("行内公式渲染成 KaTeX DOM", async () => {
    await waitForDom(() => {
      expect(host.querySelector(".cm-katex .katex")).toBeTruthy();
    });
  });

  it("Mermaid 围栏被 widget 接管（异步渲染，先出现容器）", async () => {
    // mermaid 走动态 import，并行 worker 争用时首帧可能晚到 —— 放宽到 5s
    await waitForDom(() => {
        expect(host.querySelector(".cm-mermaid")).toBeTruthy();
      });
  });

  it("光标所在行不隐藏记号（源码可见可编辑）", () => {
    view.dispatch({ selection: { anchor: 2 } }); // 落在标题行
    const firstLine = host.querySelector(".cm-line");
    expect(firstLine?.textContent ?? "").toContain("#");
  });
});

describe("源代码模式（livePreview=false）", () => {
  it("卸掉渲染装饰：表格回到源码，但语法着色仍在", async () => {
    const { createApp } = await import("vue");
    const MarkdownEditor = (await import("../src/knowledge/editor/MarkdownEditor.vue")).default;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(MarkdownEditor, {
      modelValue: "| 列一 | 列二 |\n| --- | --- |\n| a | b |\n",
      livePreview: false,
    });
    app.mount(host);
    try {
      await waitForDom(() => {
        expect(host.querySelector(".cm-content")).toBeTruthy();
      });
      // 没有表格 widget，源码可见（管道符留在文本里）
      expect(host.querySelector(".cm-kb-table")).toBeNull();
      expect(host.querySelector(".cm-content")!.textContent).toContain("| 列一 | 列二 |");
    } finally {
      app.unmount();
      host.remove();
    }
  });
});

describe("深色主题下的行号栏", () => {
  it("CM6 被显式告知明暗（不再按它默认的 light 走）", async () => {
    const { createApp, h } = await import("vue");
    const { EditorView: View } = await import("@codemirror/view");
    const MarkdownEditor = (await import("../src/knowledge/editor/MarkdownEditor.vue")).default;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp({ render: () => h(MarkdownEditor, { modelValue: "# 标题\n" }) });
    app.mount(host);
    try {
      await waitForDom(() => {
        expect(host.querySelector(".cm-content")).toBeTruthy();
      });
      const view = View.findFromDOM(host.querySelector(".cm-editor") as HTMLElement)!;
      expect(view).toBeTruthy();
      // darkTheme facet 已被设置（值取决于应用主题；关键是"已经显式告知"，不是默认的 undefined）
      expect(view.state.facet(View.darkTheme)).not.toBeUndefined();
      // 行号栏存在（样式走 token，见 live-preview.ts 的 .cm-gutters）
      expect(host.querySelector(".cm-gutters .cm-lineNumbers")).toBeTruthy();
    } finally {
      app.unmount();
      host.remove();
    }
  });
});
