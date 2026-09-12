/** Editor 分类契约：分类完备、图标齐备、类内顺序（列表在详情前）。 */
import { describe, expect, it } from "vitest";
import { editorCategories, panelTypes } from "../src/workbench/panel-types";

describe("panelTypes", () => {
  it("每个类型都有分类与图标", () => {
    for (const p of panelTypes) {
      expect(editorCategories, `${p.type} 分类不在展示顺序表`).toContain(p.category);
      expect(p.icon, `${p.type} 缺图标`).toBeTruthy();
    }
  });

  it("分类声明顺序内，列表在详情之前", () => {
    const order = panelTypes.map((p) => p.type);
    expect(order.indexOf("issue.list")).toBeLessThan(order.indexOf("issue.detail"));
    expect(order.indexOf("pull.list")).toBeLessThan(order.indexOf("pull.detail"));
  });

  it("分类数与展示顺序表一致（无空分类）", () => {
    const used = new Set(panelTypes.map((p) => p.category));
    expect([...used].sort()).toEqual([...editorCategories].sort());
  });
});
