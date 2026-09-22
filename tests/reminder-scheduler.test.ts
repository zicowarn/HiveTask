/**
 * 日程提醒调度纯函数（reminder-scheduler.ts）：锁「到点未提醒 → 应发」口径。
 * 覆盖：未到点不发、已标记不重发、无提醒不发、非法时刻诚实跳过、错过补发。
 */
import { describe, expect, it } from "vitest";
import { dueReminders } from "../src/reminder-scheduler";
import type { CalendarEventRow } from "../src/api";

const NOW = new Date("2026-09-24T12:00:00").getTime(); // 本地时区基准

const row = (over: Partial<CalendarEventRow>): CalendarEventRow => ({
  id: "e1",
  title: "压测日程",
  startDate: "2026-09-24",
  endDate: null,
  notes: null,
  remindAt: null,
  remindedAt: null,
  createdAt: "2026-09-24T00:00:00",
  updatedAt: "2026-09-24T00:00:00",
  allDay: true,
  startTime: null,
  endTime: null,
  recur: "",
  ...over,
});

describe("dueReminders（到点未提醒 → 应发）", () => {
  it("remindAt 已到点且未标记 → 应发", () => {
    const rows = [row({ remindAt: "2026-09-24T11:59:00" })];
    expect(dueReminders(rows, NOW)).toHaveLength(1);
  });

  it("remindAt 未到点 → 不发", () => {
    const rows = [row({ remindAt: "2026-09-24T12:00:01" })];
    expect(dueReminders(rows, NOW)).toHaveLength(0);
  });

  it("remindAt 恰好等于 now → 发（≤ 口径）", () => {
    const rows = [row({ remindAt: "2026-09-24T12:00:00" })];
    expect(dueReminders(rows, NOW)).toHaveLength(1);
  });

  it("remindedAt 已标记 → 不重发（幂等）", () => {
    const rows = [row({ remindAt: "2026-09-24T11:00:00", remindedAt: "2026-09-24T11:00:05" })];
    expect(dueReminders(rows, NOW)).toHaveLength(0);
  });

  it("无 remindAt → 不发", () => {
    const rows = [row({})];
    expect(dueReminders(rows, NOW)).toHaveLength(0);
  });

  it("remindAt 非法字符串 → 诚实跳过（不误发）", () => {
    const rows = [row({ remindAt: "not-a-date" })];
    expect(dueReminders(rows, NOW)).toHaveLength(0);
  });

  it("错过（remindAt 早于启动扫描很久）→ 补发一次", () => {
    const rows = [
      row({ id: "stale", remindAt: "2026-09-20T09:00:00" }),
      row({ id: "fresh", remindAt: "2026-09-24T11:59:00" }),
    ];
    const due = dueReminders(rows, NOW);
    expect(due.map((r) => r.id)).toEqual(["stale", "fresh"]);
  });
});
