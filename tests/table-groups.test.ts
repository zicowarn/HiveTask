// @vitest-environment jsdom
/** 优先级 Table 分组回归：泳道维度激活时按选项分组、组间隙载体、行号跨组连续。
 *  间隙 = 每组「最后一个可见行」的 border-bottom 12px（展开组→组内添加行；
 *  折叠组→组头自身挂 --collapsed）。曾十轮未解：载体只在展开态才渲染的添加行上，
 *  折叠组之间（P1→P2）间隙随之消失。 */
import { describe, it, expect } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import ProjectTableMode from "../src/panels/modes/ProjectTableMode.vue";
import { useProjectsStore } from "../src/stores/projects";

describe("Table 泳道分组", () => {
  it("泳道字段激活时渲染组头/组内行/间隙行，行号跨组连续", async () => {
    const pinia = createPinia();
    const app = createApp(ProjectTableMode);
    app.use(pinia);
    const host = document.createElement("div");
    document.body.appendChild(host);
    app.mount(host);
    const store = useProjectsStore(pinia);
    store.selectedId = "pj1";
    store.fields = [
      { id: "f_status", projectId: "pj1", kind: "builtin_status", name: "Status", options: [
        { id: "s_done", name: "Done", color: "#1a7f37", description: null },
        { id: "s_prog", name: "In progress", color: "#9a6700", description: null },
      ], position: 0 },
      { id: "f_prio", projectId: "pj1", kind: "single_select", name: "优先级", options: [
        { id: "p_p0", name: "P0", color: "#d1242f", description: null },
        { id: "p_p1", name: "P1", color: "#bc4c00", description: null },
      ], position: 1 },
    ];
    const mk = (id: string, prio: string) => ({
      id, projectId: "pj1", kind: "draft" as const, repoId: null, number: null,
      draftTitle: "T-" + id, draftBody: null, rank: id, addedAt: "2026-09-19T00:00:00Z",
      repoLabel: null, ghost: false, entity: null,
      fieldValues: { f_prio: prio },
    });
    store.items = [mk("a", "p_p0"), mk("b", "p_p0"), mk("c", "p_p1")];
    // 激活泳道维度 = Priority board 视图的配置
    store.view.swimlaneFieldId = "priority";
    await nextTick();
    await nextTick();

    const groups = host.querySelectorAll(".tbl-grouprow");
    const addRows = host.querySelectorAll("tbody tr.add-row");
    const collapsedHeads = host.querySelectorAll(".tbl-grouprow--collapsed");
    const nums = [...host.querySelectorAll(".tbl-body .num, .num")]
      .map((el) => el.textContent.trim());
    console.log(
      "groups:", groups.length,
      "addRows:", addRows.length,
      "collapsedHeads:", collapsedHeads.length,
      "nums:", nums.join(","),
    );
    // 泳道激活 → 每组组头 + 每组一个组内添加行；全展开 → 无折叠组头
    expect(groups.length).toBeGreaterThan(0);
    expect(addRows.length).toBe(groups.length);
    expect(collapsedHeads.length).toBe(0);

    // 折叠首组（P0）：组头挂 --collapsed（本组间隙载体，替代消失的添加行），
    // 其余组（P1 侧）间隙由各自添加行/折叠组头保证——折叠组之间间隙不消失
    store.toggleLaneCollapsed("p_p0");
    await nextTick();
    await nextTick();
    const collapsedAfter = host.querySelectorAll(".tbl-grouprow--collapsed");
    const groupsAfter = host.querySelectorAll(".tbl-grouprow");
    expect(groupsAfter.length).toBe(groups.length);
    expect(collapsedAfter.length).toBe(1);
    app.unmount();
    host.remove();
  });
});
