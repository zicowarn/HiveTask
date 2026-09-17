// @vitest-environment jsdom
/**
 * 树右键菜单的**菜单项契约**（VS Code 资源管理器对齐）：
 * 文件与目录的动作集不同、危险项为红色、分组分隔线位置、每项都有 i18n 文案。
 *
 * 另有两类**只有真机才会暴露的坑**在这里兜住：
 * - 菜单项引用的图标名不存在（`o.file-directory` 曾不在 EditorIcon 表里 → 渲染成空白图标）；
 * - 删除没走确认框（`window.confirm` 在 wry 里不弹框且恒返回 true → 无询问直接删）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";

const mocks = vi.hoisted(() => ({
  kbDelete: vi.fn(async () => {}),
  kbMove: vi.fn(async () => ({})),
  kbPickRoot: vi.fn(async () => "/tmp/kb"),
  confirmAction: vi.fn(async () => true),
}));

vi.mock("../src/api", () => ({
  isTauri: () => false,
  api: {
    kbListDir: async () => [],
    kbStat: async () => ({ exists: true, kind: "dir", size: 0, mtimeMs: 1 }),
    kbDelete: mocks.kbDelete,
    kbMove: mocks.kbMove,
    kbPickRoot: mocks.kbPickRoot,
  },
}));

vi.mock("../src/confirm", () => ({ confirmAction: mocks.confirmAction }));

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
  document.body.querySelectorAll(".am-menu").forEach((el) => el.remove());
  vi.clearAllMocks();
  mocks.confirmAction.mockResolvedValue(true);
  mocks.kbPickRoot.mockResolvedValue("/tmp/kb");
});

// jsdom 的 navigator.language 是 en —— 把语言钉成中文，断言才可读
beforeAll(async () => {
  const { useI18n } = await import("../src/i18n");
  useI18n().setLocale("zh-CN");
});

async function openMenuOn(entry: { name: string; rel: string; kind: "file" | "dir" }) {
  const { useKnowledgeStore } = await import("../src/stores/knowledge");
  const { default: KnowledgeTree } = await import("../src/knowledge/KnowledgeTree.vue");
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useKnowledgeStore();
  store.root = "/tmp/kb";
  store.children = {
    "": [
      { name: entry.name, rel: entry.rel, kind: entry.kind, size: 1, mtimeMs: 1, ignored: false },
    ],
  } as never;

  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp({ render: () => h(KnowledgeTree, { onSwitchRoot: () => {} }) });
  apps.push(app);
  app.use(pinia);
  app.mount(host);
  await nextTick();

  const row = host.querySelector(".row")!;
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  await nextTick();
}

function menuLabels(): string[] {
  // 锚点菜单 Teleport 到 body
  return Array.from(document.body.querySelectorAll(".am-menu .am-item")).map((el) => el.textContent?.trim() ?? "");
}

/** 点菜单里某一项（按文案），并把随后的异步动作推进到完成。 */
async function pick(label: string): Promise<void> {
  const item = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".am-menu .am-item")).find(
    (el) => el.textContent?.trim() === label,
  );
  expect(item, `菜单里没有「${label}」`).toBeTruthy();
  item!.click();
  await nextTick();
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await nextTick();
}

describe("树右键菜单", () => {
  it("文件：打开 / 默认应用打开 / 新建 / 重命名 / 删除 / 复制路径 / 在访达中显示", async () => {
    await openMenuOn({ name: "a.md", rel: "a.md", kind: "file" });
    const labels = menuLabels();
    expect(labels).toEqual([
      "在编辑器中打开",
      "默认应用打开",
      "新建文件…",
      "新建文件夹…",
      "复制",
      "剪切",
      "重命名…",
      "移动到…",
      "删除",
      "查看文件历史",
      "复制路径",
      "复制相对路径",
      "在文件管理器中显示",
    ]);
    // 删除是危险项（红字），且带分组标题
    const danger = document.body.querySelector(".am-item.danger")!;
    expect(danger.textContent?.trim()).toBe("删除");
  });

  it("目录：不显示「在编辑器中打开 / 默认应用打开」（对目录无意义）", async () => {
    await openMenuOn({ name: "docs", rel: "docs", kind: "dir" });
    const labels = menuLabels();
    expect(labels).not.toContain("在编辑器中打开");
    expect(labels).not.toContain("默认应用打开");
    expect(labels).toContain("重命名…");
    expect(labels).toContain("删除");
  });
});

describe("树右键菜单：剪贴板与顺序（对齐 SoloMD / MarkText 的分组）", () => {
  it("分组顺序：打开 → 新建 → 剪贴板 → 管理 → 路径/位置", async () => {
    await openMenuOn({ name: "a.md", rel: "a.md", kind: "file" });
    const groups = Array.from(document.body.querySelectorAll(".am-group")).map((el) => el.textContent?.trim());
    expect(groups).toEqual(["文件", "剪贴板", "管理"]);
  });

  it("剪贴板为空时不出现「粘贴」（避免点了没反应的空控件）", async () => {
    await openMenuOn({ name: "a.md", rel: "a.md", kind: "file" });
    expect(menuLabels()).not.toContain("粘贴");
  });

  it("复制/剪切/移动到…/删除 都在菜单里", async () => {
    await openMenuOn({ name: "docs", rel: "docs", kind: "dir" });
    const labels = menuLabels();
    for (const label of ["复制", "剪切", "重命名…", "移动到…", "删除"]) {
      expect(labels, `缺 ${label}`).toContain(label);
    }
    expect(labels).not.toContain("粘贴");
  });
});

describe("树右键菜单：动作接线（真机踩过的坑）", () => {
  it("每个菜单项的图标名都能渲染出图形（曾用不存在的 o.file-directory → 空白图标）", async () => {
    await openMenuOn({ name: "a.md", rel: "a.md", kind: "file" });
    const icons = Array.from(document.body.querySelectorAll(".am-menu .am-item .editor-icon"));
    expect(icons.length).toBeGreaterThan(5);
    for (const icon of icons) {
      expect(icon.childElementCount, `空白图标：${icon.outerHTML.slice(0, 80)}`).toBeGreaterThan(0);
    }
  });

  it("删除必须先问再删：取消 → 不删；确认 → 才删", async () => {
    mocks.confirmAction.mockResolvedValue(false);
    await openMenuOn({ name: "a.md", rel: "a.md", kind: "file" });
    await pick("删除");
    expect(mocks.confirmAction).toHaveBeenCalledTimes(1);
    expect(mocks.kbDelete).not.toHaveBeenCalled();

    mocks.kbDelete.mockClear();
    mocks.confirmAction.mockResolvedValue(true);
    await openMenuOn({ name: "a.md", rel: "a.md", kind: "file" });
    await pick("删除");
    expect(mocks.kbDelete).toHaveBeenCalledWith("/tmp/kb", "a.md");
  });

  it("「移动到…」选中知识库根目录是合法落点（空串不等于「根外」）", async () => {
    // 子目录里的文件移到根：目标 = 根下的同名文件
    mocks.kbMove.mockClear();
    await openMenuOn({ name: "a.md", rel: "sub/a.md", kind: "file" });
    await pick("移动到…");
    expect(mocks.kbMove).toHaveBeenCalledWith("/tmp/kb", "sub/a.md", "a.md");
  });

  it("移动到当前所在目录是**空操作**：不发命令、不刷树、不弹提示", async () => {
    mocks.kbMove.mockClear();
    // 根下的文件"移动到根" = 原地不动 —— 真发命令只会白闪一下提示
    await openMenuOn({ name: "a.md", rel: "a.md", kind: "file" });
    await pick("移动到…");
    expect(mocks.kbMove).not.toHaveBeenCalled();
  });
});
