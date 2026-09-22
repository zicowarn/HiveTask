/**
 * 日历日程 store（S4）：手建事件（app.db `calendar_events`）的应用内共享状态。
 * 日历面板（渲染/编辑）与状态栏（今日格）共用同一份——任一侧增删改，
 * 另一侧即时反映，无需手动刷新。
 */
import { ref } from "vue";
import { defineStore } from "pinia";
import { api, isTauri, type CalendarEventRow } from "../api";

function byStart(a: CalendarEventRow, b: CalendarEventRow): number {
  return a.startDate === b.startDate ? a.id.localeCompare(b.id) : a.startDate.localeCompare(b.startDate);
}

export const useCalendarStore = defineStore("calendar", () => {
  const events = ref<CalendarEventRow[]>([]);
  let loaded = false;

  /** 懒加载一次（面板挂载 / 状态栏挂载都会调，幂等）。 */
  async function ensureEvents(): Promise<void> {
    if (loaded || !isTauri()) return;
    loaded = true;
    try {
      events.value = await api.calendarEventList();
    } catch {
      loaded = false; // 失败允许下次重试
    }
  }

  async function reload(): Promise<void> {
    if (!isTauri()) return;
    try {
      events.value = await api.calendarEventList();
    } catch {
      // 诚实保留旧数据
    }
  }

  // ---- 提交热力（每仓库，应用级缓存）----
  // 组件内持有会导致：切工作区卸载面板 → 缓存清零 → 重挂后等异步拉取，
  // 角标出现约 2 秒空窗。提到 store 按仓库路径键控，缓存命中时挂载即有。

  /** path → (date → 提交数)。 */
  const commitHeat = ref<Map<string, Map<string, number>>>(new Map());

  /** 缓存命中返回 false（调用方无需重挂）；新拉取成功返回 true。 */
  async function ensureCommitHeat(path: string): Promise<boolean> {
    if (commitHeat.value.has(path)) return false;
    try {
      const rows = await api.gitCommitActivity(path, 366);
      commitHeat.value = new Map(commitHeat.value).set(
        path,
        new Map(rows.map((r) => [r.date, r.count])),
      );
      return true;
    } catch {
      return false; // 诚实无热力（非本地仓/读取失败）
    }
  }

  async function create(
    title: string,
    startDate: string,
    endDate?: string | null,
    allDay?: boolean,
    startTime?: string | null,
    endTime?: string | null,
    notes?: string | null,
    remindAt?: string | null,
    recur?: string,
  ): Promise<CalendarEventRow> {
    const row = await api.calendarEventCreate(
      title, startDate, endDate, allDay, startTime, endTime, notes, remindAt, recur,
    );
    events.value = [...events.value, row].sort(byStart);
    return row;
  }

  async function update(
    id: string,
    title: string,
    startDate: string,
    endDate?: string | null,
    allDay?: boolean,
    startTime?: string | null,
    endTime?: string | null,
    notes?: string | null,
    remindAt?: string | null,
    recur?: string,
  ): Promise<CalendarEventRow> {
    const row = await api.calendarEventUpdate(
      id, title, startDate, endDate, allDay, startTime, endTime, notes, remindAt, recur,
    );
    events.value = events.value.map((e) => (e.id === row.id ? row : e)).sort(byStart);
    return row;
  }

  async function remove(id: string): Promise<void> {
    await api.calendarEventRemove(id);
    events.value = events.value.filter((e) => e.id !== id);
  }

  /** 通知已发标记（reminder-scheduler 专用）：仅改本地镜像，避免整行重拉。 */
  function markReminded(id: string, remindedAt: string): void {
    events.value = events.value.map((e) => (e.id === id ? { ...e, remindedAt } : e));
  }

  return { events, ensureEvents, reload, create, update, remove, markReminded, commitHeat, ensureCommitHeat };
});
