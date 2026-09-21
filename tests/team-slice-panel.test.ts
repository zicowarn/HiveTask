// @vitest-environment jsdom
/** Team items 左导航回归（平台 Slicer，常驻面板非弹层）：
 *  顶行（字段名 ▾ + Deselect）、值行（描述 + 计数，默认隐藏零条目值）、
 *  底部 Show/Hide empty values 开关。 */
import { describe, it, expect } from "vitest";
import { createApp, nextTick } from "vue";
import { createPinia } from "pinia";
import TeamSlicePanel from "../src/panels/TeamSlicePanel.vue";
import { useProjectsStore } from "../src/stores/projects";

describe("TeamSlicePanel 左导航", () => {
  it("渲染字段切换 + Deselect + 值行描述 + 空值显隐开关", async () => {
    const pinia = createPinia();
    const app = createApp(TeamSlicePanel);
    app.use(pinia);
    const host = document.createElement("div");
    document.body.appendChild(host);
    app.mount(host);
    const store = useProjectsStore(pinia);
    store.selectedId = "pj1";
    store.fields = [
      { id: "f_status", projectId: "pj1", kind: "builtin_status", name: "Status", options: [
        { id: "s_back", name: "Backlog", color: "#8250df", description: null },
        { id: "s_prog", name: "In progress", color: "#9a6700", description: "This is actively being worked on" },
        { id: "s_done", name: "Done", color: "#d1242f", description: "This has been completed" },
      ], position: 0 },
    ];
    const mk = (id: string, status: string) => ({
      id, projectId: "pj1", kind: "draft" as const, repoId: null, number: null,
      draftTitle: "T-" + id, draftBody: null, rank: id, addedAt: "2026-09-19T00:00:00Z",
      repoLabel: null, ghost: false, entity: undefined,
      fieldValues: { f_status: status },
    });
    store.items = [mk("a", "s_prog"), mk("b", "s_done"), mk("c", "s_done")];
    store.view.sliceFieldId = "status";
    store.view.sliceValue = "s_done";
    await nextTick();
    await nextTick();

    // 顶行：字段名（Slice by 触发器）+ Deselect
    expect(host.querySelector(".tsp-field")!.textContent).toContain("Status");
    expect(host.querySelector(".tsp-deselect")!.textContent).toContain("Deselect");
    // 值行默认隐藏零条目值（Backlog 0 条不出现），描述随行渲染
    const labels = [...host.querySelectorAll(".tsp-name")].map((e) => e.textContent!.trim());
    expect(labels).toEqual(["In progress", "Done"]);
    const descs = [...host.querySelectorAll(".tsp-desc")].map((e) => e.textContent!.trim());
    expect(descs).toEqual(["This is actively being worked on", "This has been completed"]);
    // 选中行：Done 行首 ✓
    const onRow = host.querySelector(".tsp-row.on")!;
    expect(onRow.querySelector(".tsp-name")!.textContent!.trim()).toBe("Done");
    // 底部开关：默认「Show empty values」，点击后翻转并显示零条目值
    const toggleBtn = host.querySelector<HTMLButtonElement>(".tsp-empty-toggle")!;
    expect(toggleBtn.textContent!.trim()).toBe("Show empty values");
    toggleBtn.click();
    await nextTick();
    expect(store.view.sliceShowEmpty).toBe(true);
    const labelsAfter = [...host.querySelectorAll(".tsp-name")].map((e) => e.textContent!.trim());
    expect(labelsAfter).toEqual(["Backlog", "In progress", "Done"]);
    expect(host.querySelector(".tsp-empty-toggle")!.textContent!.trim()).toBe("Hide empty values");
    // Deselect：清空选中
    (host.querySelector(".tsp-deselect") as HTMLButtonElement).click();
    await nextTick();
    expect(store.view.sliceValue).toBeNull();
    app.unmount();
    host.remove();
  });
});
