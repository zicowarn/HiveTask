// @vitest-environment jsdom
/**
 * 树的行内边距与缩进参考线（用户口径：行首基准 8px、每级 8px、顶部间隔 4px）。
 *
 * jsdom 没有布局引擎（getBoundingClientRect 全 0），所以这里断言的是**组件算出的样式值**——
 * 也就是"设计意图"这一层；真正的观感由实机截图确认。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createApp, h, type App } from "vue";
import { createPinia } from "pinia";
import type { KbEntry } from "../src/api";

const apps: App[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
});

async function render(entry: KbEntry, depth: number) {
  const { default: KnowledgeTreeNode } = await import("../src/knowledge/KnowledgeTreeNode.vue");
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp({ render: () => h(KnowledgeTreeNode, { entry, depth }) });
  apps.push(app);
  app.use(createPinia());
  app.mount(host);
  await new Promise((r) => setTimeout(r, 10));
  return host;
}

const file = (rel: string): KbEntry => ({
  name: rel.split("/").pop()!,
  rel,
  kind: "file",
  size: 1,
  mtimeMs: 1,
  ignored: false,
});

describe("树的行度量", () => {
  it("行首基准 8px，每加深一级 +8px", async () => {
    expect((await render(file("a.md"), 0)).querySelector<HTMLElement>(".row")!.style.paddingLeft).toBe("8px");
    expect((await render(file("a.md"), 1)).querySelector<HTMLElement>(".row")!.style.paddingLeft).toBe("16px");
    expect((await render(file("a.md"), 3)).querySelector<HTMLElement>(".row")!.style.paddingLeft).toBe("32px");
  });

  it("参考线宽度 = 深度 × 8px（与祖先箭头列同 x，故 left 固定 8px）", async () => {
    expect((await render(file("a.md"), 1)).querySelector<HTMLElement>(".guides")!.style.width).toBe("8px");
    expect((await render(file("a.md"), 2)).querySelector<HTMLElement>(".guides")!.style.width).toBe("16px");
  });

  it("根层不画参考线", async () => {
    expect((await render(file("a.md"), 0)).querySelector(".guides")).toBeNull();
  });
});
