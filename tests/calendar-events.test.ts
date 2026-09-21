/**
 * 日历事件聚合契约（calendar-events.ts）：投影图层不存数据，只做
 * 「真源 → 事件」转换。锁住四图层归一、非法/缺日期诚实跳过、项目日期
 * 字段逐 (条目×字段) 成事件、标题组装四条规则。
 */
import { describe, expect, it } from "vitest";
import {
  buildCalendarEvents,
  dateKey,
  eventsOnDate,
  expandOccurrences,
  heatBucket,
  layerPrio,
  localDateOf,
  occursOn,
} from "../src/panels/calendar-events";
import type { ProjectField, ProjectItem } from "../src/api";
import type { Issue, Pull } from "../src/types";

const milestone = (dueOn: string | null, number = 1, title = "v1.0") => ({
  number,
  title,
  description: null,
  dueOn,
  state: "open",
  openIssues: 0,
  closedIssues: 0,
  htmlUrl: dueOn ? `https://github.com/o/r/milestone/${number}` : null,
});

const issue = (over: Partial<Issue> = {}): Issue => ({
  number: "12",
  title: "Bug",
  state: "OPEN",
  labels: [],
  assignees: [],
  ...over,
});

const pull = (over: Partial<Pull> = {}): Pull => ({
  number: 7,
  title: "Feature",
  state: "OPEN",
  labels: [],
  assignees: [],
  reviewers: [],
  additions: 0,
  deletions: 0,
  commits: 0,
  comments: 0,
  isDraft: false,
  ...over,
});

const dateField: ProjectField = {
  id: "f-date",
  projectId: "p1",
  kind: "date",
  name: "Target",
  options: [],
  position: 0,
};
const textField: ProjectField = { ...dateField, id: "f-text", kind: "text", name: "Note" };

const item = (over: Partial<ProjectItem> = {}): ProjectItem => ({
  id: "i1",
  projectId: "p1",
  kind: "draft",
  repoId: null,
  number: null,
  draftTitle: "发版准备",
  draftBody: null,
  rank: "Q1",
  addedAt: "2026-01-01T00:00:00Z",
  repoLabel: null,
  ghost: false,
  fieldValues: {},
  ...over,
});

/** 本地正午 ISO：任何时区下 localDateOf 都应归到同一天。 */
const isoOf = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).toISOString();

describe("localDateOf", () => {
  it("ISO 串归到本地日期；空/非法诚实返回 null", () => {
    expect(localDateOf(isoOf(2026, 3, 5))).toBe("2026-03-05");
    expect(localDateOf(null)).toBeNull();
    expect(localDateOf("")).toBeNull();
    expect(localDateOf("not-a-date")).toBeNull();
  });
});

describe("dateKey", () => {
  it("本地日期键不经 UTC 往返（日界边缘不漂移）", () => {
    expect(dateKey(new Date(2026, 2, 5))).toBe("2026-03-05");
    expect(dateKey(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
    expect(dateKey(new Date(2026, 0, 1))).toBe("2026-01-01");
  });
});

describe("eventsOnDate（状态栏今日格口径：只数手建日程）", () => {
  const ev = (startDate: string, endDate: string | null = null) =>
    ({ id: `${startDate}-${endDate}`, startDate, endDate }) as never;

  it("单日命中当天；跨日覆盖窗口内每一天；窗口外不命中", () => {
    const rows = [ev("2026-09-18"), ev("2026-09-20", "2026-09-22"), ev("2026-09-10")];
    expect(eventsOnDate(rows, "2026-09-18").length).toBe(1);
    expect(eventsOnDate(rows, "2026-09-20").length).toBe(1, );
    expect(eventsOnDate(rows, "2026-09-21").length).toBe(1);
    expect(eventsOnDate(rows, "2026-09-22").length).toBe(1);
    expect(eventsOnDate(rows, "2026-09-23").length).toBe(0);
    expect(eventsOnDate(rows, "2026-09-19").length).toBe(0);
  });

  it("同一天多条全数计入", () => {
    const rows = [ev("2026-09-18"), ev("2026-09-18"), ev("2026-09-17", "2026-09-19")];
    expect(eventsOnDate(rows, "2026-09-18").length).toBe(3);
  });
});

describe("occursOn / expandOccurrences（重复日程）", () => {
  const MON = "2026-01-05"; // 周一

  it("daily：起始日起每天；起始日前不发生", () => {
    expect(occursOn(MON, null, "daily", MON)).toBe(true);
    expect(occursOn(MON, null, "daily", "2026-03-01")).toBe(true);
    expect(occursOn(MON, null, "daily", "2026-01-04")).toBe(false);
  });

  it("weekly：同星期命中；跨度随发生日平移", () => {
    expect(occursOn(MON, null, "weekly", "2026-01-12")).toBe(true);
    expect(occursOn(MON, null, "weekly", "2026-01-13")).toBe(false);
    // 跨度 1-05..1-07（周一锚 + 2 天）→ 下周同窗 1-12..1-14 均命中，周四不命中
    expect(occursOn(MON, "2026-01-07", "weekly", "2026-01-12")).toBe(true);
    expect(occursOn(MON, "2026-01-07", "weekly", "2026-01-13")).toBe(true);
    expect(occursOn(MON, "2026-01-07", "weekly", "2026-01-14")).toBe(true);
    expect(occursOn(MON, "2026-01-07", "weekly", "2026-01-15")).toBe(false);
  });

  it("monthly：同日命中；短月自然跳过（1-31）", () => {
    expect(occursOn("2026-01-31", null, "monthly", "2026-03-31")).toBe(true);
    expect(occursOn("2026-01-31", null, "monthly", "2026-02-28")).toBe(false);
    expect(occursOn("2026-01-31", null, "monthly", "2026-04-30")).toBe(false);
  });

  it("yearly：同月日命中；平年自动跳过 2-29", () => {
    expect(occursOn("2024-02-29", null, "yearly", "2028-02-29")).toBe(true);
    expect(occursOn("2024-02-29", null, "yearly", "2026-02-28")).toBe(false);
    expect(occursOn("2024-02-29", null, "yearly", "2025-02-29")).toBe(false);
  });

  it("expandOccurrences：周重复展开为可视区间内的全部发生日", () => {
    expect(expandOccurrences(MON, null, "weekly", "2026-01-01", "2026-01-31")).toEqual([
      "2026-01-05",
      "2026-01-12",
      "2026-01-19",
      "2026-01-26",
    ]);
  });

  it("expandOccurrences：不重复且起始在区间前——返回起始日（渲染端 fc end 补跨度）", () => {
    expect(expandOccurrences("2025-12-30", "2026-01-02", "", "2026-01-01", "2026-01-31")).toEqual([
      "2025-12-30",
    ]);
  });
});

describe("heatBucket", () => {
  it("GitHub 贡献图口径四档：0 无 / ≤2 低 / ≤5 中 / ≤9 高 / ≥10 峰值", () => {
    expect(heatBucket(0)).toBe(0);
    expect(heatBucket(1)).toBe(1);
    expect(heatBucket(2)).toBe(1);
    expect(heatBucket(3)).toBe(2);
    expect(heatBucket(5)).toBe(2);
    expect(heatBucket(6)).toBe(3);
    expect(heatBucket(9)).toBe(3);
    expect(heatBucket(10)).toBe(4);
    expect(heatBucket(99)).toBe(4);
  });
});

describe("buildCalendarEvents", () => {
  it("里程碑 dueOn 成事件并带线上链接；无截止跳过", () => {
    const events = buildCalendarEvents({
      milestones: [milestone(isoOf(2026, 9, 30)), milestone(null, 2)],
      issues: [],
      pulls: [],
      projectFields: [],
      projectItems: [],
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      date: "2026-09-30",
      kind: "milestone",
      id: "milestone:1",
      title: "v1.0",
      url: "https://github.com/o/r/milestone/1",
    });
  });

  it("Issue/PR createdAt 成事件，标题带编号；缺 createdAt 跳过", () => {
    const events = buildCalendarEvents({
      milestones: [],
      issues: [issue({ createdAt: isoOf(2026, 2, 1) }), issue({ number: "13" })],
      pulls: [pull({ createdAt: isoOf(2026, 2, 2) }), pull({ number: 8 })],
      projectFields: [],
      projectItems: [],
    });
    expect(events.map((e) => e.id)).toEqual(["issue:12", "pull:7"]);
    expect(events[0]).toMatchObject({ date: "2026-02-01", kind: "issue", title: "#12 Bug" });
    expect(events[1]).toMatchObject({ date: "2026-02-02", kind: "pull", title: "#7 Feature" });
  });

  it("项目日期字段：仅 date 类型且字段名进标题；文本字段与非草稿实体标题规则", () => {
    const entityItem = item({
      id: "i2",
      kind: "issue",
      number: "12",
      draftTitle: null,
      entity: { title: "Bug", state: "OPEN", author: null, assignees: [], labels: [], milestone: null, createdAt: null, updatedAt: null },
      fieldValues: { "f-date": isoOf(2026, 4, 1) },
    });
    const events = buildCalendarEvents({
      milestones: [],
      issues: [],
      pulls: [],
      projectFields: [dateField, textField],
      projectItems: [entityItem, item({ fieldValues: { "f-text": isoOf(2026, 4, 2) } })],
    });
    // 文本字段的值不产生事件；issue 实体标题 = "#12 Bug · Target"
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      date: "2026-04-01",
      kind: "project",
      id: "project:i2:f-date",
      title: "#12 Bug · Target",
      url: null,
    });
  });

  it("空输入 → 空事件表（面板空态由调用方渲染提示）", () => {
    expect(
      buildCalendarEvents({ milestones: [], issues: [], pulls: [], projectFields: [], projectItems: [] }),
    ).toEqual([]);
  });
});

describe("layerPrio（折叠优先级：日程/订阅节气假日 > 投影）", () => {
  it("手建日程最低值（格高不足时最先保留）", () => {
    expect(layerPrio("event:e1:2026-09-24")).toBeLessThan(layerPrio("feed:f1:d:t"));
    expect(layerPrio("event:e1:2026-09-24")).toBeLessThan(layerPrio("issue:15956"));
  });

  it("订阅（节气/假日）压过投影类", () => {
    expect(layerPrio("feed:f1:d:t")).toBeLessThan(layerPrio("issue:15956"));
    expect(layerPrio("feed:f1:d:t")).toBeLessThan(layerPrio("pull:3"));
    expect(layerPrio("feed:f1:d:t")).toBeLessThan(layerPrio("project:1:2"));
    expect(layerPrio("feed:f1:d:t")).toBeLessThan(layerPrio("milestone:7"));
  });

  it("同层返回 0 差——回退 fc 默认链（start/-duration/allDay/title）", () => {
    expect(layerPrio("event:a") - layerPrio("event:b")).toBe(0);
    expect(layerPrio("issue:1") - layerPrio("pull:2")).toBe(0);
  });
});
