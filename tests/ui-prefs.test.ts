/**
 * 「工作内容」级 UI 偏好的持久化桥（src/ui-prefs.ts）。
 *
 * 背景（用户定案 2026-09-22：装出来的应用才是正式的家）：webview 的 localStorage 按
 * 「安装形态 + 来源」分库——开发态 `~/Library/WebKit/<进程名>` + `http://localhost:1420`，
 * 安装版按 bundle id + `tauri://localhost`。所以凡是"我的工作内容指向"的键都要落 app.db
 * （路径由 Rust 常量决定，与安装形态无关），localStorage 退化为本形态的镜像。
 *
 * 这里钉的是**划线**（哪些键走 app.db）与**合并规则**（app.db 覆盖镜像 / 镜像里多出来的上搬），
 * 都是纯函数，不碰 IPC。
 */
import { describe, expect, it } from "vitest";
import { isDurableKey, planHydration } from "../src/ui-prefs";

describe("划线：哪些键算「工作内容」", () => {
  it("走 app.db：知识库、项目视图配置、工作台布局、分支 review base、最近仓库", () => {
    for (const key of [
      "hivetask.kb.root",
      "hivetask.kb.recent",
      "hivetask.kb.recentFiles",
      "hivetask.kb.view",
      "hivetask.kb.treeRatio",
      "hivetask.kb.showIgnored",
      "hivetask.project-view.r18d4dbb82a089ef8b46",
      "hivetask.project-views.r18d4dbb82a089ef8b46",
      "hivetask.workbench-layout-v1",
      "hivetask.branchreview.base.tauri-apps/tauri",
      "hivetask.lastRepo",
      "hivetask.recentRepos",
    ]) {
      expect(isDurableKey(key), key).toBe(true);
    }
  });

  it("留在 localStorage：这台机器上的偏好（主题 / 语言 / shell / 间隔 / 面板 Mode / 工作区）", () => {
    for (const key of [
      "hivetask.theme",
      "hivetask.locale",
      "hivetask.terminalShell",
      "hivetask.syncInterval",
      "hivetask.calendarLunar",
      "hivetask.statusbar",
      "hivetask.workspace",
      "hivetask.gantt-mode",
      "hivetask.gantt-critical",
      "hivetask.panel-mode.project.board",
      "hivetask.feedParserVersion",
    ]) {
      expect(isDurableKey(key), key).toBe(false);
    }
  });
});

describe("合并规则：app.db 是真理，镜像只补空缺", () => {
  it("app.db 有的键覆盖镜像（安装版第一次启动就靠这个把值灌回来）", () => {
    const { mirror, upload } = planHydration(
      [["hivetask.kb.root", "/notes"]],
      [["hivetask.kb.root", null], ["hivetask.theme", "light"]],
    );
    expect(mirror).toEqual([["hivetask.kb.root", "/notes"]]);
    expect(upload, "设备偏好不在上搬范围").toEqual([]);
  });

  it("镜像里有、app.db 没有的 → 上搬（老用户升级路径）", () => {
    const { mirror, upload } = planHydration(
      [],
      [["hivetask.kb.root", "/old-notes"], ["hivetask.workbench-layout-v1", "{}"]],
    );
    expect(mirror).toEqual([]);
    expect(upload).toEqual([
      ["hivetask.kb.root", "/old-notes"],
      ["hivetask.workbench-layout-v1", "{}"],
    ]);
  });

  it("两边一致 → 什么都不做（幂等：每次启动跑一次不该产生写入）", () => {
    const { mirror, upload } = planHydration(
      [["hivetask.kb.root", "/notes"]],
      [["hivetask.kb.root", "/notes"]],
    );
    expect(mirror).toEqual([]);
    expect(upload).toEqual([]);
  });

  it("非「工作内容」键即使只在镜像里也不上搬（设备偏好不进库）", () => {
    const { upload } = planHydration([], [["hivetask.theme", "light"]]);
    expect(upload).toEqual([]);
  });

  it("镜像被清空（安装版首启）→ 全部由 app.db 补回", () => {
    const db: [string, string][] = [
      ["hivetask.kb.root", "/notes"],
      ["hivetask.workbench-layout-v1", "{\"a\":1}"],
    ];
    const { mirror } = planHydration(db, [
      ["hivetask.kb.root", null],
      ["hivetask.workbench-layout-v1", null],
    ]);
    expect(mirror).toEqual(db);
  });
});
