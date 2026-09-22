// @vitest-environment jsdom
/**
 * 「打开方式」设置：**用户点名改的形态**必须守住。
 *
 * 背景（用户实测反馈）：原来那一行右侧是「应用名输入框 + 选择应用…按钮」，让用户手打应用名；
 * 用户要求**去掉**，改成在「按扩展名指定」的子项里**选系统里的应用**。
 *
 * 所以这里守三件事：
 * ① 默认应用行**没有**输入框与按钮（控件本体移除，不是改文案）；
 * ② 子项的应用格是统一的下拉选择器（`DropdownMenu`），条目来自系统：
 *    LaunchServices 的"系统默认/已登记应用" + 已装应用清单；
 * ③ 选中后写盘的是**应用路径**（避免同名歧义），并且写进的是 byExt 这一条规则。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";

const saved: unknown[] = [];
const forExtCalls: string[] = [];

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {
    kbOpenPrefsGet: async () => ({ byExt: {} }),
    kbOpenPrefsSet: async (prefs: unknown) => {
      saved.push(prefs);
    },
    kbAppsList: async () => [
      { name: "Finder", path: "/System/Library/CoreServices/Finder.app" },
      { name: "Typora", path: "/Applications/Typora.app", extensions: ["md", "markdown"] },
      { name: "Visual Studio Code", path: "/Applications/Visual Studio Code.app", extensions: ["md", "ts"] },
    ],
    kbAppsForExt: async (ext: string) => {
      forExtCalls.push(ext);
      if (ext !== "md") return { default: null, candidates: [] };
      return {
        default: { name: "Typora", path: "/Applications/Typora.app" },
        candidates: [{ name: "Visual Studio Code", path: "/Applications/Visual Studio Code.app" }],
      };
    },
    kbPickApp: async () => "/Applications/Custom.app",
    connectionList: async () => [],
    calendarFeedList: async () => [],
    // 数据区块（每日备份 + 设备包）在 onMounted 里读它；缺了会走错误分支
    backupStatus: async () => ({ dir: "/tmp/backups", count: 2, latest: "app-20260922.db" }),
    calendarFeedAdd: async () => {},
    calendarFeedSync: async () => {},
    calendarFeedSetEnabled: async () => {},
    calendarFeedRemove: async () => {},
    calendarFeedSetColor: async () => {},
    ghAuthUser: async () => null,
  },
}));

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
  saved.length = 0;
  forExtCalls.length = 0;
  document.body.innerHTML = "";
});

/** 让挂载/交互后的响应式更新与微任务都跑完。 */
async function flush(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

beforeAll(async () => {
  const { useI18n } = await import("../src/i18n");
  useI18n().setLocale("zh-CN");
});

async function mountSettings(): Promise<HTMLElement> {
  setActivePinia(createPinia());
  const { default: SettingsBasicMode } = await import("../src/panels/modes/SettingsBasicMode.vue");
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp(SettingsBasicMode);
  apps.push(app);
  app.mount(host);
  await flush();
  return host;
}

/** 找到「打开方式」那一行（按标题文字定位，抗结构微调）。 */
function openWithRow(host: HTMLElement): HTMLElement | null {
  const rows = [...host.querySelectorAll<HTMLElement>(".setting-row")];
  return rows.find((row) => row.textContent?.includes("打开方式")) ?? null;
}

async function addRule(host: HTMLElement, ext: string): Promise<HTMLElement> {
  const add = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes("添加规则"),
  );
  add?.click();
  await flush();
  const rows = [...host.querySelectorAll<HTMLElement>(".byext-row")];
  const row = rows[rows.length - 1];
  const input = row.querySelector<HTMLInputElement>("input.byext-ext");
  input!.value = ext;
  input!.dispatchEvent(new Event("input"));
  input!.dispatchEvent(new Event("blur"));
  await flush();
  return row;
}

describe("设置「打开方式」：控件形态按用户要求改过", () => {
  it("默认应用行里没有输入框、没有按钮（控件本体已移除）", async () => {
    const host = await mountSettings();
    const row = openWithRow(host);
    expect(row, "应有「打开方式」行").toBeTruthy();
    expect(row!.querySelectorAll("input, button, select")).toHaveLength(0);
    // 说明文字仍在（改的是控件，不是整行）
    expect(row!.textContent).toContain("系统默认");
  });

  it("子项的应用格是下拉选择器，条目来自系统（默认 + 已登记 + 全部应用）", async () => {
    const host = await mountSettings();
    const row = await addRule(host, "md");
    const trigger = row.querySelector<HTMLButtonElement>(".dd-trigger");
    expect(trigger, "应用格应是 DropdownMenu 触发器").toBeTruthy();
    trigger!.click();
    await flush();

    expect(forExtCalls).toContain("md");
    const menu = document.querySelector<HTMLElement>(".dd-menu");
    expect(menu, "菜单应打开").toBeTruthy();
    const text = menu!.textContent ?? "";
    expect(text).toContain("系统默认应用");
    expect(text).toContain("Typora");
    expect(text).toContain("系统登记的其他应用");
    expect(text).toContain("全部应用");
    expect(text).toContain("Finder");
  });

  it("选中应用后写盘的是应用路径，且落在该扩展名的规则上", async () => {
    const host = await mountSettings();
    const row = await addRule(host, "md");
    row.querySelector<HTMLButtonElement>(".dd-trigger")!.click();
    await flush();

    const options = [...document.querySelectorAll<HTMLButtonElement>(".dd-menu .dd-row")];
    const typora = options.find((o) => o.textContent?.includes("Typora"));
    expect(typora).toBeTruthy();
    typora!.click();
    await flush();

    const last = saved.at(-1) as { byExt: Record<string, string> };
    expect(last.byExt).toEqual({ ".md": "/Applications/Typora.app" });
  });

  it("扩展名为空时不问系统（没有可查的类型），菜单也不至于空白报错", async () => {
    const host = await mountSettings();
    const add = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("添加规则"),
    );
    add?.click();
    await flush();
    const row = [...host.querySelectorAll<HTMLElement>(".byext-row")].pop()!;
    row.querySelector<HTMLButtonElement>(".dd-trigger")!.click();
    await flush();
    expect(forExtCalls).toEqual([]);
    expect(document.querySelector(".dd-menu")).toBeTruthy();
  });

  it("「浏览…」动作在菜单顶部，选完把原生选择器的结果作为该行应用", async () => {
    const host = await mountSettings();
    const row = await addRule(host, "dwg");
    row.querySelector<HTMLButtonElement>(".dd-trigger")!.click();
    await flush();
    const action = document.querySelector<HTMLButtonElement>(".dd-menu .dd-act");
    expect(action?.textContent).toContain("选择应用");
    action!.click();
    await flush();
    const last = saved.at(-1) as { byExt: Record<string, string> };
    expect(last.byExt).toEqual({ ".dwg": "/Applications/Custom.app" });
  });

  it("旧配置里手填的应用名照旧显示（不丢用户已有配置）", async () => {
    const host = await mountSettings();
    // 直接改 store 里的值（模拟从 app.db 读出的历史配置）
    const { useKnowledgeStore } = await import("../src/stores/knowledge");
    const store = useKnowledgeStore();
    await store.saveOpenWith({ byExt: { ".md": "Typora" } });
    await nextTick();
    await flush();
    const row = [...host.querySelectorAll<HTMLElement>(".byext-row")].pop()!;
    expect(row.querySelector(".dd-trigger")?.textContent).toContain("Typora");
  });
});
