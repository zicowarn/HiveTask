/**
 * 静态依赖桩：gh-errors / menu-defs / sync-meta 的模块顶层都会触到
 * 浏览器全局（localStorage / navigator / matchMedia），node 环境没有。
 * 用一个可配置的内存实现打桩，各测试文件共享。
 */
import { vi } from "vitest";

const storage = new Map<string, string>();

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
