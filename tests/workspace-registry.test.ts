/**
 * 工作区注册表契约：每个工作区的面板类型都必须真实注册过（白名单、
 * 标题/图标元数据齐全），否则工作区 tab 切过去就是空面板——这类错
 * 编译器抓不到，只有跑起来才看得见。
 *
 * 顺带锁住 2026-09-22 的定案：设置的家是「通用」工作区（⌘6），
 * 与编辑器切换弹层的 `editorCat.general` 同名同位。
 */
import { describe, expect, it } from "vitest";
import { editorCategories, panelTypes } from "../src/workbench/panel-types";
import { workspaces } from "../src/workbench/workspaces";

const types = new Set(panelTypes.map((p) => p.type));

describe("工作区注册表", () => {
  it("每个工作区的列/详情面板都已注册", () => {
    for (const ws of workspaces) {
      expect(types, `${ws.key} 的 listPanel`).toContain(ws.listPanel);
      expect(types, `${ws.key} 的 detailPanel`).toContain(ws.detailPanel);
    }
  });

  it("工作区 key 与标签不重复", () => {
    expect(new Set(workspaces.map((w) => w.key)).size).toBe(workspaces.length);
    expect(new Set(workspaces.map((w) => w.labelKey)).size).toBe(workspaces.length);
  });

  it("通用工作区 = 单面板的设置（设置 Editor 列入通用下方）", () => {
    const general = workspaces.find((w) => w.key === "general");
    expect(general, "应有通用工作区").toBeTruthy();
    expect(general!.labelKey).toBe("workspace.general");
    // 单面板：不做两栏拆分（同「项目」「知识库」）
    expect(general!.listPanel).toBe("settings");
    expect(general!.detailPanel).toBe("settings");
    // 设置面板在切换弹层里也归「通用」分类（同名同位，不是两套叙事）
    const settings = panelTypes.find((p) => p.type === "settings");
    expect(settings?.category).toBe("editorCat.general");
    expect(editorCategories).toContain("editorCat.general");
  });
});
