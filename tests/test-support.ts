/**
 * 静态依赖桩：gh-errors / menu-defs / sync-meta 的模块顶层都会触到
 * 浏览器全局（localStorage / navigator / matchMedia），node 环境没有。
 * 用一个可配置的内存实现打桩，各测试文件共享。
 */
import { vi } from "vitest";

/**
 * DOM 等待的统一入口：`vi.waitFor` 默认只等 1s，而 jsdom + CM6/Mermaid 在并行 worker
 * 争用时首帧经常晚到（实测：门禁里紧随构建之后跑时偶发失败）。这里放宽到 6s。
 */
export async function waitForDom(assertion: () => void, timeoutMs = 6000): Promise<void> {
  await vi.waitFor(assertion, { timeout: timeoutMs, interval: 25 });
}

const storage = new Map<string, string>();

/**
 * jsdom 没有实现 ResizeObserver（真实引擎都有）。CAD 预览用它做"适应窗口"的
 * 尺寸跟随，不桩上会直接抛错、整个渲染失败——那是测试环境的缺口，不是产品问题。
 */
export function stubResizeObserver(): void {
  if (typeof globalThis.ResizeObserver !== "undefined") return;
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
}

export function stubBrowserGlobals(locale = "zh-CN"): void {
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
  });
  vi.stubGlobal("navigator", { language: locale });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  storage.clear();
}
