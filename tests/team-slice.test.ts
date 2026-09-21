// @vitest-environment jsdom
/** Team items 切片回归（平台 Slicer，2026-09 取证 views/3）：
 *  值行（含无值行/计数/排序）、切片过滤、字段切换与 No slicing。 */
import { describe, it, expect } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useProjectsStore } from "../src/stores/projects";

describe("Team items 切片", () => {
  it("assignees 切片：值行计数排序 + 过滤 + 切字段 + 不切片收起", () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useProjectsStore();
    store.selectedId = "pj1";
    store.fields = [
      { id: "f_status", projectId: "pj1", kind: "builtin_status", name: "Status", options: [
        { id: "s_done", name: "Done", color: "#1a7f37", description: null },
        { id: "s_prog", name: "In progress", color: "#9a6700", description: null },
      ], position: 0 },
    ];
    const mk = (id: string, who: string[]) => ({
      id, projectId: "pj1", kind: "issue" as const, repoId: "r1", number: "1",
      draftTitle: null, draftBody: null, rank: id, addedAt: "2026-09-19T00:00:00Z",
      repoLabel: "repo", ghost: false,
      entity: { assignees: who } as never,
      fieldValues: { f_status: "s_done" },
    });
    store.items = [
      mk("a", ["alice"]),
      mk("b", ["alice"]),
      mk("c", ["bob"]),
      mk("d", []),
    ];

    // 激活 assignees 切片（Team items 视图形态）；未选中值 = 显示全量
    store.view.sliceFieldId = "assignees";
    store.view.sliceValue = null;
    const rows = store.sliceRows;
    expect(rows.map((r) => r.label)).toEqual(["alice", "bob", "No Assignees"]);
    expect(rows.map((r) => r.count)).toEqual([2, 1, 1]);
    expect(rows[0]!.avatar).toContain("github.com/alice.png");

    // 过滤：选中 bob → 主区只剩 bob 的条目
    store.setSliceValue("bob");
    expect(store.filteredItems.map((i) => i.id)).toEqual(["c"]);
    // 无值行 → 空切片
    store.setSliceValue("");
    expect(store.filteredItems.map((i) => i.id)).toEqual(["d"]);

    // 切到状态字段：值行 = 选项 + 计数；选中值清空（Deselect 语义：保持未选中）
    store.setSliceField("status");
    expect(store.sliceRows.map((r) => r.label)).toEqual(["Done", "In progress"]);
    expect(store.sliceRows[0]!.count).toBe(4);
    expect(store.view.sliceValue).toBeNull();
    expect(store.filteredItems.length).toBe(4);

    // 值面板的空值显隐：默认隐藏零条目值，开启后全量
    store.setSliceField("assignees");
    store.setSliceValue("bob");
    expect(store.sliceRows.filter((r) => r.count > 0).map((r) => r.label)).toEqual(["alice", "bob", "No Assignees"]);
    store.setSliceShowEmpty(true);
    expect(store.view.sliceShowEmpty).toBe(true);

    // No slicing：面板收起、过滤解除
    store.setSliceField(null);
    expect(store.sliceActive).toBe(false);
    expect(store.filteredItems.length).toBe(4);
  });
});
