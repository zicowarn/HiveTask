/** 菜单结构契约：四个菜单、快捷键、禁用态（原生菜单与兜底渲染共用此数据）。 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubBrowserGlobals } from "./test-support";

beforeEach(() => stubBrowserGlobals());
const { setLocale } = await import("../src/i18n");
setLocale("zh-CN");
const { buildMenuDefs } = await import("../src/menu-defs");

const actions = Object.fromEntries(
  ["pickRepo", "refresh", "refreshDisabled", "openPreferences", "gotoIssues", "gotoPulls", "gotoTools", "statusbarVisible", "toggleStatusbar", "githubUrlMissing", "openInGithub", "copyUrl", "openAbout", "quickOpen", "searchKnowledge", "knowledgeReady"].map(
    (name) => [name, vi.fn()],
  ),
) as never;

describe("buildMenuDefs", () => {
  it("四个顶级菜单，顺序与标签跟随语言", () => {
    const menus = buildMenuDefs(actions);
    expect(menus.map((m) => m.label)).toEqual(["文件", "视图", "工具", "帮助"]);
  });

  it("没选知识库根时，快速打开与搜索置灰（点了也没东西可搜）", () => {
    const disabled = buildMenuDefs({ ...(actions as object), knowledgeReady: () => false } as never);
    const view = disabled[1].items;
    expect(view.find((i) => i.shortcut === "⌘P")?.disabled).toBe(true);
    expect(view.find((i) => i.shortcut === "⌘⇧F")?.disabled).toBe(true);

    const enabled = buildMenuDefs({ ...(actions as object), knowledgeReady: () => true } as never);
    const on = enabled[1].items;
    expect(on.find((i) => i.shortcut === "⌘P")?.disabled).toBeFalsy();
    expect(on.find((i) => i.shortcut === "⌘⇧F")?.disabled).toBeFalsy();
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
    // 快速打开/搜索：视图菜单里的全局入口（VS Code 的命令面板也在 View 下）
    const view = menus[1].items;
    expect(view.find((i) => i.shortcut === "⌘P")?.label).toBe("快速打开…");
    expect(view.find((i) => i.shortcut === "⌘⇧F")?.label).toBe("在知识库中搜索…");
    expect(menus[2].items.map((i) => i.label)).toEqual(["在 GitHub 打开", "复制链接"]);
    expect(menus[3].items[0].label).toBe("关于 HiveTask");
  });
});
