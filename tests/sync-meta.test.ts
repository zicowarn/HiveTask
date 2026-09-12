/**
 * sync-meta 键名归一化回归测试——曾经的真实事故：Rust 盖章带
 * "synced:" 前缀、前端查找用裸键，重启后从 DB 加载的键全部 miss，
 * 状态栏 ⟳ 消失。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {
    listSyncedAt: vi
      .fn()
      .mockResolvedValue([
        ["synced:issues:open", "2026-09-11T02:00:00Z"],
        ["synced:pulls:open", "2026-09-11T09:11:40Z"],
      ]),
  },
}));

vi.mock("../src/stores/repo", () => ({
  useRepoStore: () => ({ current: "/tmp/tauri-real", origin: null, recent: [] }),
}));

describe("sync-meta", () => {
  it("加载时剥掉 synced: 前缀，map 键与查找/echo 口径一致", async () => {
    const { useSyncMetaStore } = await import("../src/stores/sync-meta");
    const { createPinia, setActivePinia } = await import("pinia");
    setActivePinia(createPinia());

    const store = useSyncMetaStore();
    await store.load();
    expect(Object.keys(store.map).sort()).toEqual(["issues:open", "pulls:open"]);
    expect(store.map["pulls:open"]).toBe("2026-09-11T09:11:40Z");
  });

  it("stamp 写裸键（与查找口径一致）", async () => {
    const { useSyncMetaStore } = await import("../src/stores/sync-meta");
    const { createPinia, setActivePinia } = await import("pinia");
    setActivePinia(createPinia());

    const store = useSyncMetaStore();
    store.stamp("issues:open");
    expect(store.map["issues:open"]).toBeTruthy();
    expect(Object.keys(store.map).some((k) => k.startsWith("synced:"))).toBe(false);
  });
});
