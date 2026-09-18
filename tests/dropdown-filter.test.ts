// @vitest-environment jsdom
/**
 * DropdownMenu 的 `filterable`（长列表搜索）与 `openChange`（懒加载钩子）。
 *
 * 为什么加在共用组件上而不是在设置页自绘一个菜单：AGENTS.md 规定"下拉一律走
 * DropdownMenu"，一百多个应用的清单又必须有搜索框 —— 只能把这个能力做进共用组件，
 * 且**默认关闭**（`filterable` 不传时行为与本改动前完全一致，其他调用方零影响）。
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { stubBrowserGlobals } from "./test-support";

const apps: App[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
  document.body.innerHTML = "";
});

beforeAll(() => {
  stubBrowserGlobals();
});

async function mountMenu(props: Record<string, unknown>): Promise<HTMLElement> {
  const { default: DropdownMenu } = await import("../src/components/DropdownMenu.vue");
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp(DropdownMenu, props);
  apps.push(app);
  app.mount(host);
  await nextTick();
  return host;
}

const SECTIONS = [
  {
    title: "系统默认应用",
    options: [{ value: "/Applications/Typora.app", label: "Typora" }],
  },
  {
    title: "全部应用",
    options: [
      { value: "/Applications/Finder.app", label: "Finder" },
      { value: "/Applications/Visual Studio Code.app", label: "Visual Studio Code" },
    ],
  },
];

async function openMenu(host: HTMLElement): Promise<HTMLElement> {
  host.querySelector<HTMLButtonElement>(".dd-trigger")!.click();
  await nextTick();
  await nextTick();
  return document.querySelector<HTMLElement>(".dd-menu")!;
}

describe("DropdownMenu.filterable", () => {
  it("不传 filterable 时没有搜索框（其他调用方不受影响）", async () => {
    const host = await mountMenu({ sections: SECTIONS, modelValue: "" });
    const menu = await openMenu(host);
    expect(menu.querySelector(".dd-filter")).toBeNull();
    expect(menu.querySelectorAll(".dd-row")).toHaveLength(3);
  });

  it("开了就有搜索框，输入后只留命中的行，空组连标题一起隐藏", async () => {
    const host = await mountMenu({ sections: SECTIONS, modelValue: "", filterable: true });
    const menu = await openMenu(host);
    const filter = menu.querySelector<HTMLInputElement>(".dd-filter");
    expect(filter).toBeTruthy();

    filter!.value = "code";
    filter!.dispatchEvent(new Event("input"));
    await nextTick();

    const labels = [...menu.querySelectorAll(".dd-row")].map((row) => row.textContent?.trim());
    expect(labels).toEqual(["Visual Studio Code"]);
    expect(menu.textContent).not.toContain("系统默认应用");
  });

  it("搜不到时显示空态（不是一片空白）", async () => {
    const host = await mountMenu({ sections: SECTIONS, modelValue: "", filterable: true });
    const menu = await openMenu(host);
    const filter = menu.querySelector<HTMLInputElement>(".dd-filter")!;
    filter.value = "不存在的应用";
    filter.dispatchEvent(new Event("input"));
    await nextTick();
    expect(menu.querySelectorAll(".dd-row")).toHaveLength(0);
    expect(menu.querySelector(".dd-empty")).toBeTruthy();
  });

  it("搜索框里回车选中第一条命中项", async () => {
    const updates: unknown[] = [];
    const { default: DropdownMenu } = await import("../src/components/DropdownMenu.vue");
    const host = document.createElement("div");
    document.body.appendChild(host);
    hosts.push(host);
    const app = createApp(DropdownMenu, {
      sections: SECTIONS,
      modelValue: "",
      filterable: true,
      "onUpdate:modelValue": (value: unknown) => updates.push(value),
    });
    apps.push(app);
    app.mount(host);
    await nextTick();

    const menu = await openMenu(host);
    const filter = menu.querySelector<HTMLInputElement>(".dd-filter")!;
    filter.value = "find";
    filter.dispatchEvent(new Event("input"));
    await nextTick();
    filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    expect(updates).toEqual(["/Applications/Finder.app"]);
  });

  it("openChange 报开合（调用方据此懒加载系统数据），关闭时也报一次", async () => {
    const events: boolean[] = [];
    const { default: DropdownMenu } = await import("../src/components/DropdownMenu.vue");
    const host = document.createElement("div");
    document.body.appendChild(host);
    hosts.push(host);
    const app = createApp(DropdownMenu, {
      sections: SECTIONS,
      modelValue: "",
      "onOpenChange": (value: boolean) => events.push(value),
    });
    apps.push(app);
    app.mount(host);
    await nextTick();

    const trigger = host.querySelector<HTMLButtonElement>(".dd-trigger")!;
    trigger.click();
    await nextTick();
    trigger.click();
    await nextTick();
    expect(events).toEqual([true, false]);
  });

  it("选中后搜索词清掉（下次打开是完整列表）", async () => {
    const host = await mountMenu({ sections: SECTIONS, modelValue: "", filterable: true });
    let menu = await openMenu(host);
    const filter = menu.querySelector<HTMLInputElement>(".dd-filter")!;
    filter.value = "code";
    filter.dispatchEvent(new Event("input"));
    await nextTick();
    menu.querySelector<HTMLButtonElement>(".dd-row")!.click();
    await nextTick();
    menu = await openMenu(host);
    expect(menu.querySelector<HTMLInputElement>(".dd-filter")!.value).toBe("");
    expect(menu.querySelectorAll(".dd-row")).toHaveLength(3);
  });
});
