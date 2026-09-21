// @vitest-environment jsdom
/**
 * 编辑器 wikilink 装饰的回归测试（v3）：
 *  ① `[[别名]]` / `[[target|别名]]` / `[[target#小节]]` 都产出 .cm-wikilink，
 *     data-wikilink 是剥好的 target（跳转与补全共用的消解键）；
 *  ② 代码围栏内不装饰（与图谱索引同一忽略口径）；
 *  ③ 装饰覆盖整段 `[[…]]` 记号。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, type App } from "vue";

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
});

async function mount(doc: string): Promise<HTMLElement> {
  const MarkdownEditor = (await import("../src/knowledge/editor/MarkdownEditor.vue")).default;
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp({ render: () => h(MarkdownEditor, { modelValue: doc }) });
  apps.push(app);
  app.mount(host);
  await new Promise((resolve) => setTimeout(resolve, 50));
  return host;
}

describe("编辑器 wikilink 装饰", () => {
  it("三种形态都装饰，data-wikilink 为剥好的 target", async () => {
    const host = await mount("[[Alpha]] 与 [[Beta|别名]]、[[Gamma#小节]]");
    const links = [...host.querySelectorAll(".cm-wikilink")];
    const targets = links.map((el) => el.getAttribute("data-wikilink"));
    expect(targets).toContain("Alpha");
    expect(targets).toContain("Beta");
    expect(targets).toContain("Gamma");
    expect(links.every((el) => el.textContent?.startsWith("[[") && el.textContent?.endsWith("]]"))).toBe(true);
  });

  it("代码围栏内不装饰", async () => {
    const host = await mount(["正文 [[Yes]]", "```", "[[InFence]]", "```"].join("\n"));
    const targets = [...host.querySelectorAll(".cm-wikilink")].map((el) => el.getAttribute("data-wikilink"));
    expect(targets).toContain("Yes");
    expect(targets).not.toContain("InFence");
  });

  it("行内代码内不装饰（与 Rust 索引口径一致）", async () => {
    const host = await mount("文字 `[[Inline]]` 与 [[Real]]");
    const targets = [...host.querySelectorAll(".cm-wikilink")].map((el) => el.getAttribute("data-wikilink"));
    expect(targets).toContain("Real");
    expect(targets).not.toContain("Inline");
  });
});
