/** 菜单结构契约：四个菜单、快捷键、禁用态（原生菜单与兜底渲染共用此数据）。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());
const { buildMenuDefs } = await import("../src/menu-defs");

const actions = Object.fromEntries(
  ["pickRepo", "refresh", "refreshDisabled", "openPreferences", "gotoIssues", "gotoPulls", "gotoTools", "statusbarVisible", "toggleStatusbar", "githubUrlMissing", "openInGithub", "copyUrl", "openAbout"].map(
    (name) => [name, vi.fn()],
  ),
) as never;

describe("buildMenuDefs", () => {
  it("四个顶级菜单，顺序与标签跟随语言", () => {
    const menus = buildMenuDefs(actions);
    expect(menus.map((m) => m.label)).toEqual(["文件", "视图", "工具", "帮助"]);
  });

  it("英文目录下标签切换", async () => {
    const { setLocale } = await import("../src/i18n");
    setLocale("en-US");
    const menus = buildMenuDefs(actions);
    expect(menus.map((m) => m.label)).toEqual(["File", "View", "Tools", "Help"]);
    setLocale("zh-CN");
  });

  it("数据菜单结构完整：快捷键与关键动作就位", () => {
    const menus = buildMenuDefs(actions);
    const file = menus[0].items;
    expect(file[0]).toMatchObject({ label: "选择仓库…", shortcut: "⌘O" });
    expect(menus[1].items.filter((i) => i.shortcut === "⌘3")).toHaveLength(1);
    expect(menus[2].items.map((i) => i.label)).toEqual(["在 GitHub 打开", "复制链接"]);
    expect(menus[3].items[0].label).toBe("关于 HiveTask");
  });
});
