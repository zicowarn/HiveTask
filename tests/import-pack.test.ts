// @vitest-environment jsdom
/**
 * 导入设备包对话框：《架构设计-导出与导入》的「安全默认」是硬要求——
 * 三选一必须**预选后端给的建议**（本机较新 → 保留；包较新 → 覆盖），
 * 且应用时把**用户当前看到的选择**逐项交给后端（不重算、不静默改动）。
 *
 * 这里守三件事：
 * ① 预览后每行的动作 = 后端 suggestion（不是恒定的某一项）；
 * ② 用户改选后，应用带过去的是改后的值；
 * ③ 没选文件时「应用导入」不可点（避免空包误操作）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

type Decision = Record<string, string>;
const applied: { decisions: Decision }[] = [];

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {
    readTextFile: async () => '{"format":"hivetask.export"}',
    importPreview: async () => [
      {
        id: "p-local-newer",
        name: "家庭装修",
        localUpdatedAt: "2026-09-20T10:00:00Z",
        packUpdatedAt: "2026-09-19T10:00:00Z",
        suggestion: "keep",
        items: 3,
        fields: 2,
      },
      {
        id: "p-pack-newer",
        name: "机房改造",
        localUpdatedAt: "2026-09-18T10:00:00Z",
        packUpdatedAt: "2026-09-21T10:00:00Z",
        suggestion: "overwrite",
        items: 5,
        fields: 4,
      },
      {
        id: "p-absent",
        name: "新项目",
        localUpdatedAt: null,
        packUpdatedAt: "2026-09-21T10:00:00Z",
        suggestion: "add",
        items: 1,
        fields: 1,
      },
    ],
    importApply: async (_json: string, decisions: Decision) => {
      applied.push({ decisions });
      return [1, 1, 1];
    },
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: async () => "/tmp/pack.export",
}));

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
  applied.length = 0;
  document.body.innerHTML = "";
});

async function flush(): Promise<void> {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

beforeAll(async () => {
  const { useI18n } = await import("../src/i18n");
  useI18n().setLocale("zh-CN");
});

async function mountDialog(): Promise<HTMLElement> {
  const { default: ImportPackDialog } = await import("../src/components/ImportPackDialog.vue");
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp(ImportPackDialog, { open: true });
  apps.push(app);
  app.mount(host);
  await flush();
  return host;
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(text),
  );
}

async function pickPack(host: HTMLElement): Promise<HTMLElement[]> {
  buttonByText(host, "选择设备包文件")?.click();
  await flush();
  return [...host.querySelectorAll<HTMLElement>(".pack-item")];
}

describe("导入设备包：三选一按系统建议预选", () => {
  it("没有选文件时「应用导入」不可点", async () => {
    const host = await mountDialog();
    expect(buttonByText(host, "应用导入")?.disabled).toBe(true);
  });

  it("每行预选后端建议（保留 / 覆盖 / 新增），不是恒定项", async () => {
    const host = await mountDialog();
    const rows = await pickPack(host);
    expect(rows).toHaveLength(3);
    const labels = rows.map((row) => row.querySelector(".dd-trigger")?.textContent?.trim() ?? "");
    expect(labels[0]).toContain("保留本机");
    expect(labels[1]).toContain("覆盖");
    expect(labels[2]).toContain("新增");
  });

  it("改选后应用带的是用户当前选择（逐项，不缺项）", async () => {
    const host = await mountDialog();
    const rows = await pickPack(host);

    // 第 2 行（建议覆盖）改成「保留本机」
    rows[1].querySelector<HTMLButtonElement>(".dd-trigger")?.click();
    await flush();
    const menu = document.querySelector<HTMLElement>(".dd-menu");
    expect(menu, "下拉菜单应打开").toBeTruthy();
    const keepOption = [...menu!.querySelectorAll<HTMLElement>(".dd-menu .dd-row")].find((el) =>
      el.textContent?.includes("保留本机"),
    );
    expect(keepOption, "菜单里应有「保留本机」").toBeTruthy();
    keepOption!.click();
    await flush();

    buttonByText(host, "应用导入")?.click();
    await flush();

    expect(applied).toHaveLength(1);
    expect(applied[0].decisions).toEqual({
      "p-local-newer": "keep",
      "p-pack-newer": "keep", // 用户改过的一项
      "p-absent": "add",
    });
  });

  it("本机没有的项目只给「新增」，本机已有的只给「覆盖/保留」（不留同名手滑口）", async () => {
    const host = await mountDialog();
    const rows = await pickPack(host);

    // 第三行（本机无）→ 菜单里没有覆盖
    rows[2].querySelector<HTMLButtonElement>(".dd-trigger")?.click();
    await flush();
    let menu = document.querySelector<HTMLElement>(".dd-menu");
    let labels = [...menu!.querySelectorAll<HTMLElement>(".dd-row")].map((el) => el.textContent ?? "");
    expect(labels.some((x) => x.includes("新增"))).toBe(true);
    expect(labels.some((x) => x.includes("覆盖"))).toBe(false);
    document.body.click();
    await flush();

    // 第一行（本机已有）→ 菜单里没有「新增」
    rows[0].querySelector<HTMLButtonElement>(".dd-trigger")?.click();
    await flush();
    menu = document.querySelector<HTMLElement>(".dd-menu");
    labels = [...menu!.querySelectorAll<HTMLElement>(".dd-row")].map((el) => el.textContent ?? "");
    expect(labels.some((x) => x.includes("覆盖"))).toBe(true);
    expect(labels.some((x) => x.includes("保留本机"))).toBe(true);
    expect(labels.some((x) => x.includes("新增"))).toBe(false);
  });

  it("有覆盖项时必须两击：第一击只上膛，不改库", async () => {
    const host = await mountDialog();
    await pickPack(host);

    // 预选里有一项建议「覆盖」→ 第一击只把按钮换成确认文案
    buttonByText(host, "应用导入")?.click();
    await flush();
    expect(applied).toHaveLength(0);
    expect(buttonByText(host, "再点一次")?.textContent).toContain("1");

    buttonByText(host, "再点一次")?.click();
    await flush();
    expect(applied).toHaveLength(1);
  });

  it("没有覆盖项时一次点击即应用（两击只服务于覆盖）", async () => {
    const host = await mountDialog();
    const rows = await pickPack(host);
    // 把唯一建议覆盖的那项改成保留
    rows[1].querySelector<HTMLButtonElement>(".dd-trigger")?.click();
    await flush();
    const keep = [...document.querySelectorAll<HTMLElement>(".dd-menu .dd-row")].find((el) =>
      el.textContent?.includes("保留本机"),
    );
    keep!.click();
    await flush();

    buttonByText(host, "应用导入")?.click();
    await flush();
    expect(applied).toHaveLength(1);
  });
});
