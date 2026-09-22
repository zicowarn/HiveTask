/**
 * 同步节律（P4 收尾）：按偏好间隔自动刷新**当前工作区**的仓库数据，
 * 并给状态栏提供「过期」判定。
 *
 * 边界（诚实、可解释）：
 * - 只刷 issues / pulls 两个仓库工作区（它们的 refresh 是幂等拉取写缓存）；
 *   项目/知识库/工具工作区不参与——那些要么是本地数据，要么刷新成本与语义都不同；
 * - **隐藏窗口不刷**（没人看就别打扰平台配额）；离线不刷（不制造假错误态）；
 * - 间隔 0 = 关：不建定时器（默认关，符合"意外联网请求要可解释"）；
 * - 刷新失败由各 store 自己呈现（本模块不吞错也不弹 toast——后台动作不该抢焦点）。
 */
import { watch } from "vue";
import { isTauri } from "./api";
import { netOnline } from "./net";
import { useIssuesStore } from "./stores/issues";
import { usePullsStore } from "./stores/pulls";
import { useSettingsStore } from "./stores/settings";

/** 可选的同步间隔（分钟）；0 = 关。 */
export const SYNC_INTERVAL_CHOICES = [0, 5, 15, 30] as const;

/** 状态栏那格的着色判定（纯函数，边界由测试钉死）：
 *  - 没时间戳 → unknown（不显示，不猜）
 *  - 关档（interval 0）→ off：**不着色**（用户明确说别管）
 *  - 超过间隔还没更新 → stale（会自动刷新却没刷上，多半是失败了/离线）
 */
export function syncFreshness(
  lastIso: string | null,
  nowMs: number,
  intervalMin: number,
): "unknown" | "off" | "fresh" | "stale" {
  if (!lastIso) return "unknown";
  const then = new Date(lastIso).getTime();
  if (Number.isNaN(then)) return "unknown";
  if (!intervalMin) return "off";
  return nowMs - then > intervalMin * 60_000 ? "stale" : "fresh";
}

/** 一次同步心跳（导出以便单测）：按当前工作区分派，守卫先过。 */
export async function runSyncTick(currentWorkspace: () => string): Promise<void> {
  // jsdom / 非浏览器环境没有 visibilityState，按"可见"处理
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (netOnline.value === false) return;
  const ws = currentWorkspace();
  if (ws === "issues") await useIssuesStore().refresh();
  else if (ws === "pulls") await usePullsStore().refresh();
}

let timer: ReturnType<typeof setInterval> | null = null;

/** 停表（测试与偏好切换共用）。 */
export function stopSyncScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 应用启动挂载（App.vue onMounted）：按设置里的间隔起定时器，偏好改了就重起。
 * 浏览器预览零副作用（同提醒调度器口径）。
 */
export function startSyncScheduler(currentWorkspace: () => string): void {
  if (!isTauri()) return;
  const settings = useSettingsStore();
  const arm = (): void => {
    stopSyncScheduler();
    const min = settings.syncIntervalMin;
    if (!min) return; // 关：不建定时器
    timer = setInterval(() => void runSyncTick(currentWorkspace), min * 60_000);
  };
  arm();
  watch(() => settings.syncIntervalMin, arm);
}
