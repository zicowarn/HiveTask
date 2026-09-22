// @vitest-environment jsdom
/**
 * 三态占位原语（LoadStateHint）与其收编边界。
 *
 * 原语的语义底线：**空与加载中永不共用一个空白**——"没数据"和"还没拿到"是两回事，
 * 混用会让人以为数据没了。收编边界同样是这次的内容：只收**全域**三态；列表里
 * "与已有数据并存的刷新提示"（如 IssueListMode 的 load-row，刷新时不清空列表）**不收**，
 * 硬套会把"刷新中仍显示旧数据"的行为换成整块骨架，是退化不是统一。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());

vi.mock("../src/api", () => ({
  isTauri: () => false,
  api: {},
}));

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((r) => setTimeout(r, 0));
  await nextTick();
}

beforeAll(async () => {
  const { useI18n } = await import("../src/i18n");
  useI18n().setLocale("zh-CN");
});

async function mountHint(props: Record<string, unknown>): Promise<HTMLElement> {
  const { default: LoadStateHint } = await import("../src/components/LoadStateHint.vue");
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp(LoadStateHint, props);
  apps.push(app);
  app.mount(host);
  await flush();
  return host;
}

describe("LoadStateHint 三态", () => {
  it("loading = 骨架脉冲（不是文案，更不是空白）", async () => {
    const host = await mountHint({ state: "loading" });
    expect(host.querySelectorAll(".skeleton").length).toBe(2);
    expect(host.querySelector(".lsh-text")).toBeNull();
  });

  it("empty = 调用方文案（原语不管业务措辞）", async () => {
    const host = await mountHint({ state: "empty", text: "这里还没有东西" });
    expect(host.querySelector(".lsh-text")?.textContent).toBe("这里还没有东西");
    expect(host.querySelectorAll(".skeleton").length).toBe(0);
  });

  it("error = 红字 + 原文折在下方 + 重试按钮发 retry", async () => {
    const host = await mountHint({ state: "error", error: "gh: not logged in" });
    expect(host.querySelector(".lsh-error")?.textContent).toBe("加载失败");
    expect(host.querySelector(".lsh-detail")?.textContent, "原文保留，便于排查").toBe("gh: not logged in");
    const retried = vi.fn();
    const { default: LoadStateHint } = await import("../src/components/LoadStateHint.vue");
    const app = createApp(LoadStateHint, { state: "error", onRetry: retried });
    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    hosts.push(host2);
    apps.push(app);
    app.mount(host2);
    await flush();
    host2.querySelector<HTMLButtonElement>(".lsh-retry")!.click();
    expect(retried).toHaveBeenCalledTimes(1);
  });

  it("error 无原文时不留空行（detail 行按需渲染）", async () => {
    const host = await mountHint({ state: "error" });
    expect(host.querySelector(".lsh-detail")).toBeNull();
    expect(host.querySelector(".lsh-retry")).toBeTruthy();
  });
});
