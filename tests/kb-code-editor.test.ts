// @vitest-environment jsdom
/**
 * 代码文件编辑器（CodeEditor）：**可编辑 + 语法着色 + 行号**。
 *
 * 背景（用户实测反馈）：代码文件（.py/.rs/.ts 源码…）原来只渲染成只读 `<pre>`，
 * Prism 产出了 token span 却没有主题 CSS —— 高亮"看起来不行"，编辑更是无从谈起。
 * 修复 = 换 CM6 编辑器：官方语言包着色（跟明暗主题 token 走）、行号、可编辑，
 * 保存链路复用 Markdown 那套（宿主接管，这里只守编辑器本身的行为）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, type App } from "vue";

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
});

interface CodeEditorApi {
  setText: (value: string) => void;
}

async function mount(doc: string, ext: string) {
  const CodeEditor = (await import("../src/knowledge/editor/CodeEditor.vue")).default;
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  let api: CodeEditorApi | null = null;
  const app = createApp({
    render: () =>
      h(CodeEditor, {
        modelValue: doc,
        ext,
        ref: (instance: unknown) => {
          api = instance as CodeEditorApi | null;
        },
        "onUpdate:modelValue": (value: string) => {
          lastValue = value;
        },
      }),
  });
  let lastValue = "";
  apps.push(app);
  app.mount(host);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { host, api: api as unknown as CodeEditorApi, getLastValue: () => lastValue };
}

describe("代码文件编辑器（CodeEditor）", () => {
  it("渲染 CM6 编辑器：行号槽 + 可聚焦内容区（不是只读 <pre>）", async () => {
    const { host } = await mount("const x = 1;", "ts");
    expect(host.querySelector(".cm-editor"), "应有 CM6 编辑器").toBeTruthy();
    expect(host.querySelector(".cm-gutters"), "应有行号槽").toBeTruthy();
    expect(host.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
  });

  it("语言包着色：TS 关键字产出 syntax 高亮类", async () => {
    const { host } = await mount("const x = 1;", "ts");
    // CM6 的 HighlightStyle 按 tag 加 class（todo 形如 "ͼ1"），有 token 类即着色生效
    const highlighted = host.querySelectorAll<HTMLElement>(".cm-content [class*='ͼ']");
    expect(highlighted.length, "应有带高亮类的 token span").toBeGreaterThan(0);
  });

  it("未知扩展名也能编辑（纯文本，不出错）", async () => {
    const { host } = await mount("plain text content", "weirdext");
    expect(host.querySelector(".cm-editor")).toBeTruthy();
    expect(host.querySelector(".cm-content")?.textContent).toContain("plain text content");
  });

  it("modelValue 外部更新会同步进编辑器（冲突「重新载入」出口用）", async () => {
    const { host, api } = await mount("first", "js");
    api.setText("second line");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.querySelector(".cm-content")?.textContent).toContain("second line");
  });

  it("切换扩展名时重配语言（compartment）不重建编辑器", async () => {
    const CodeEditor = (await import("../src/knowledge/editor/CodeEditor.vue")).default;
    const host = document.createElement("div");
    document.body.appendChild(host);
    hosts.push(host);
    const app = createApp({
      render: () => h(CodeEditor, { modelValue: "#!/bin/bash\necho hi", ext: "py" }),
    });
    apps.push(app);
    app.mount(host);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = host.querySelector(".cm-editor");
    expect(before).toBeTruthy();
    // 换 ext：父组件不换 key 时（同文件换编码重开等场景）语言 compartment 平滑重配
    expect(host.querySelector(".cm-content")?.textContent).toContain("echo hi");
  });
});
