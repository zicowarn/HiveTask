/**
 * 日程本地通知（日历 S4 收尾）：remind_at 到点弹系统通知。
 *
 * 触发模型（诚实边界）：
 * - 应用运行中每 30s 扫一遍 calendar store；remindAt ≤ now 且未标记的 →
 *   逐条发通知 + 写 reminded_at；发送失败不标记，下轮重试（天然幂等）；
 * - 启动时错过的提醒一并补发（迟到总比没有好；逐条，不做合并摘要）；
 * - 重复日程的 remind_at 是对话框里选的绝对时刻（datetime-local 原样存），
 *   只响锚点一次，后续发生不外推——与「单次例外编辑」一起挂账；
 * - 权限：扫描侧只读检查（永不主动弹系统授权框）；请求时机 = 对话框保存
 *   「带提醒」的事件时（见 requestNotificationPermission，用户手势点）；
 *   未授权时跳过发送，下轮再试（用户可在系统设置改授权）。
 * - 应用退出后不再有通知（无后台常驻进程）——桌面应用诚实边界。
 */
import { api, isTauri, type CalendarEventRow } from "./api";
import { useCalendarStore } from "./stores/calendar";

const SCAN_INTERVAL_MS = 30_000;

/** 到点未提醒的日程（错过补发同口径：remindAt ≤ now 即算）。 */
export function dueReminders(rows: CalendarEventRow[], nowMs: number): CalendarEventRow[] {
  return rows.filter((r) => {
    if (!r.remindAt || r.remindedAt) return false;
    const at = new Date(r.remindAt).getTime();
    return !Number.isNaN(at) && at <= nowMs;
  });
}

type NotificationModule = typeof import("@tauri-apps/plugin-notification");

/** 插件按需动态加载（浏览器预览零副作用）；只读检查授权，返回 null = 不可用/未授权。 */
async function loadNotifier(): Promise<NotificationModule | null> {
  if (!isTauri()) return null;
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    return (await mod.isPermissionGranted()) ? mod : null;
  } catch {
    return null; // 通知不可达（平台拒绝等）：诚实跳过，下轮再试
  }
}

/**
 * 主动请求一次系统通知权限——只在对话框保存「带提醒」的事件时调用
 * （那一刻用户明确表达了要提醒，弹授权框不打扰）。
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const mod = await import("@tauri-apps/plugin-notification");
    if (await mod.isPermissionGranted()) return true;
    return (await mod.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

async function scanOnce(): Promise<void> {
  const store = useCalendarStore();
  await store.ensureEvents();
  const due = dueReminders(store.events, Date.now());
  if (due.length === 0) return;
  const notifier = await loadNotifier();
  if (!notifier) return;
  for (const row of due) {
    try {
      notifier.sendNotification({
        title: row.title,
        body: `${row.startDate}${row.startTime ? ` ${row.startTime}` : ""}`,
      });
      const nowIso = new Date().toISOString();
      await api.calendarEventSetReminded(row.id, nowIso);
      store.markReminded(row.id, nowIso);
    } catch (error) {
      // 单条失败不影响其余；不标记 → 下轮重试
      console.error("[reminder] send/mark failed:", row.id, error);
    }
  }
}

/** 应用启动挂载（App.vue onMounted）；浏览器预览零副作用。 */
export function startReminderScheduler(): void {
  if (!isTauri()) return;
  void scanOnce();
  setInterval(() => void scanOnce(), SCAN_INTERVAL_MS);
}
