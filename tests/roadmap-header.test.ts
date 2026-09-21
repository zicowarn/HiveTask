import { describe, it, expect } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import ProjectRoadmapMode from "../src/panels/modes/ProjectRoadmapMode.vue";
import { useProjectsStore } from "../src/stores/projects";

// @vitest-environment jsdom
/** Roadmap 表头回归：日期字段就绪时必须生成月标签与日号（2026-09 对齐取证）。 */
describe("Roadmap 表头", () => {
  it("日期字段就绪时生成月标签与日号", async () => {
    const pinia = createPinia();
    const app = createApp(ProjectRoadmapMode);
    app.use(pinia);
    const host = document.createElement("div");
    document.body.appendChild(host);
    app.mount(host);
    const store = useProjectsStore(pinia);
    store.selectedId = "pj1";
    store.fields = [
      { id: "f_status", projectId: "pj1", kind: "builtin_status", name: "Status", options: [], position: 0 },
      { id: "f_start", projectId: "pj1", kind: "date", name: "Start date", options: [], position: 1 },
      { id: "f_end", projectId: "pj1", kind: "date", name: "End date", options: [], position: 2 },
    ];
    store.items = [
      {
        id: "it1", projectId: "pj1", kind: "draft", repoId: null, number: null,
        draftTitle: "T1", draftBody: null, rank: "a", addedAt: "2026-09-19T00:00:00Z",
        repoLabel: null, ghost: false, entity: null,
        fieldValues: { f_start: "2026-09-10", f_end: "2026-09-14" },
      },
    ];
    await nextTick();
    await nextTick();
    const months = host.querySelectorAll(".rm-month");
    const days = host.querySelectorAll(".rm-day");
    expect(months.length).toBeGreaterThan(0);
    expect(days.length).toBeGreaterThan(0);
    expect([...months].map((m) => m.textContent.trim()).join(",")).toMatch(/2026/);
    expect(days[0].textContent.trim()).not.toBe("");
    // 表格收口结构：条目区容器（rm-lanes）包住 addrow 与今日红线（红线止于
    // 内容底，不越过收口线——红线过长曾被要求修正）；收口线在容器之后、灰带之前
    const lanes = host.querySelector(".rm-lanes");
    const addrow = host.querySelector(".rm-addrow");
    const tableend = host.querySelector(".rm-tableend");
    const filler = host.querySelector(".rm-filler");
    expect(lanes).toBeTruthy();
    expect(addrow).toBeTruthy();
    expect(tableend).toBeTruthy();
    expect(filler).toBeTruthy();
    expect(lanes!.contains(addrow!)).toBe(true);
    expect(tableend!.nextElementSibling).toBe(filler);
    expect(lanes!.nextElementSibling).toBe(tableend);
    // 今日红线在条目区容器内（有今日时渲染，撑满容器高）
    const line = host.querySelector(".rm-todayline");
    if (line) expect(lanes!.contains(line)).toBe(true);
    app.unmount();
    host.remove();
  });
});
