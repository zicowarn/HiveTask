// @vitest-environment jsdom
/**
 * 同步节律（P4 收尾）的纯逻辑与心跳守卫。
 *
 * 用户口径（路线图 P4 最后一项）：同步间隔偏好（关 / 5 / 15 / 30 分钟）+ 状态栏过期着色。
 * 这里钉死两件事：**过期判定的边界**（关档绝不着色、超过间隔才算）与**心跳的守卫**
 * （隐藏窗口不刷、离线不刷、非仓库工作区不刷）——后台自动联网请求必须可解释，
 * 不能"悄悄替用户做主"。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());

const refreshed: string[] = [];

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {},
}));

vi.mock("../src/stores/issues", () => ({
  useIssuesStore: () => ({ refresh: async () => void refreshed.push("issues") }),
}));
vi.mock("../src/stores/pulls", () => ({
  usePullsStore: () => ({ refresh: async () => void refreshed.push("pulls") }),
}));

const NOW = Date.parse("2026-09-22T12:00:00Z");

describe("过期判定（状态栏着色）", () => {
  it("没过时间戳 / 时间戳坏掉 → unknown（不猜、不显示）", async () => {
    const { syncFreshness } = await import("../src/sync-scheduler");
    expect(syncFreshness(null, NOW, 15)).toBe("unknown");
    expect(syncFreshness("not-a-date", NOW, 15)).toBe("unknown");
  });

  it("间隔关（0）→ off：无论多旧都不着色（用户说了别管）", async () => {
    const { syncFreshness } = await import("../src/sync-scheduler");
    expect(syncFreshness("2020-01-01T00:00:00Z", NOW, 0)).toBe("off");
  });

  it("超过间隔才算 stale；边界值不算（> 而非 >=）", async () => {
    const { syncFreshness } = await import("../src/sync-scheduler");
    const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
    expect(syncFreshness(at(0), NOW, 15)).toBe("fresh");
    expect(syncFreshness(at(14), NOW, 15)).toBe("fresh");
    expect(syncFreshness(at(15), NOW, 15), "刚好到点还算新鲜").toBe("fresh");
    expect(syncFreshness(at(16), NOW, 15)).toBe("stale");
    // 关档与间隔无关
    expect(syncFreshness(at(999), NOW, 15)).toBe("stale");
  });
});

describe("心跳守卫", () => {
  beforeEach(() => {
    refreshed.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("只刷当前工作区的仓库数据：issues → issues，pulls → pulls，其它工作区什么都不做", async () => {
    const { runSyncTick } = await import("../src/sync-scheduler");
    await runSyncTick(() => "issues");
    expect(refreshed).toEqual(["issues"]);
    await runSyncTick(() => "pulls");
    expect(refreshed).toEqual(["issues", "pulls"]);
    await runSyncTick(() => "projects");
    await runSyncTick(() => "tools");
    await runSyncTick(() => "general");
    expect(refreshed, "非仓库工作区不产生联网刷新").toEqual(["issues", "pulls"]);
  });

  it("隐藏窗口不刷（没人看就别打扰平台配额）", async () => {
    const { runSyncTick } = await import("../src/sync-scheduler");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await runSyncTick(() => "issues");
    expect(refreshed).toEqual([]);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    await runSyncTick(() => "issues");
    expect(refreshed).toEqual(["issues"]);
  });

  it("离线不刷（不制造假错误态）", async () => {
    const { runSyncTick } = await import("../src/sync-scheduler");
    const { netOnline } = await import("../src/net");
    netOnline.value = false;
    await runSyncTick(() => "issues");
    expect(refreshed).toEqual([]);
    netOnline.value = null; // 未知（还没探过）时照刷——首启探针就是这么工作的
    await runSyncTick(() => "issues");
    expect(refreshed).toEqual(["issues"]);
  });
});
