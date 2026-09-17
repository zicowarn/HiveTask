/** 视图字段目录契约：三层来源齐备、字段名键一一对应、默认全开。 */
import { describe, expect, it } from "vitest";
import {
  defaultViewConfig,
  entityFieldIds,
  fieldLabelKeys,
  projectFieldIds,
  viewFieldIds,
} from "../src/panels/project-views";

describe("viewFieldIds", () => {
  it("无重复，且覆盖 条目 / 引用实体 / 项目字段 三层", () => {
    expect(new Set(viewFieldIds).size).toBe(viewFieldIds.length);
    for (const id of ["title", "kind", "source", "added"]) expect(viewFieldIds).toContain(id);
    for (const id of entityFieldIds) expect(viewFieldIds).toContain(id);
    for (const id of projectFieldIds) expect(viewFieldIds).toContain(id);
  });

  it("每个字段都有 i18n 名称键，且键名在 project.col* 命名空间内", () => {
    for (const id of viewFieldIds) {
      expect(fieldLabelKeys[id].startsWith("project.col"), `${id} 缺少名称键`).toBe(true);
    }
  });

  it("默认配置：全部字段打开、无筛选、手动排序、分列回落状态字段", () => {
    const config = defaultViewConfig();
    expect(config.fields).toEqual([...viewFieldIds]);
    expect(config.filter).toBe("");
    expect(config.sortBy).toBe("manual");
    expect(config.sortDesc).toBe(false);
    expect(config.columnFieldId).toBeNull();
  });
});
