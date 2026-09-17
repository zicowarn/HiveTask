// @vitest-environment jsdom
/**
 * 预览注册表：**扩展名 + magic 双路判定**、按需加载、无插件时返回 null。
 * 这是 T8 的地基——判错会把 PDF 交给代码高亮渲染，或把 zip 当二进制卡片。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const bytes = (head: number[]): Uint8Array => new Uint8Array(head);

beforeEach(() => {
  vi.resetModules();
});

describe("预览注册表判定", () => {
  it("扩展名优先命中，且各格式互不串台", async () => {
    const { resolvePreview: resolve } = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview"); // 副作用注册

    // `%PDF` 四字节齐全（只给两字节会被按"magic 不符"淘汰——这是刻意的严格判定）
    const pdf = await resolve(
      { root: "/r", rel: "a.pdf", name: "a.pdf", ext: "pdf" },
      async () => bytes([0x25, 0x50, 0x44, 0x46]),
    );
    expect(pdf?.id).toBe("pdf");

    const code = await resolve({ root: "/r", rel: "a.rs", name: "a.rs", ext: "rs" }, async () => bytes([0x66]));
    expect(code?.id).toBe("text");

    const zip = await resolve(
      { root: "/r", rel: "a.zip", name: "a.zip", ext: "zip" },
      async () => bytes([0x50, 0x4b, 0x03, 0x04]),
    );
    expect(zip?.id).toBe("archive");

    const mail = await resolve({ root: "/r", rel: "a.eml", name: "a.eml", ext: "eml" }, async () => bytes([0x46]));
    expect(mail?.id).toBe("email");
  });

  it("扩展名不认识时用 magic 兜底（改名的 PDF 也能认出）", async () => {
    const { resolvePreview: resolve } = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");
    const renamed = await resolve(
      { root: "/r", rel: "noext", name: "noext", ext: "" },
      async () => bytes([0x25, 0x50, 0x44, 0x46, 0x2d]), // %PDF-
    );
    expect(renamed?.id).toBe("pdf");
  });

  it("扩展名是 pdf 但内容是别的东西 → 交给 magic 兜底（不再误判为 pdf）", async () => {
    const { resolvePreview: resolve } = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");
    const fake = await resolve(
      { root: "/r", rel: "fake.pdf", name: "fake.pdf", ext: "pdf" },
      async () => bytes([0x50, 0x4b, 0x03, 0x04]), // 其实是 zip
    );
    expect(fake?.id).toBe("archive");
  });

  it("没有任何插件认领 → null（宿主给「暂不支持」卡片）", async () => {
    const { resolvePreview: resolve } = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");
    const unknown = await resolve(
      { root: "/r", rel: "a.zzz", name: "a.zzz", ext: "zzz" },
      async () => bytes([0x00, 0x01, 0x02, 0x03]),
    );
    expect(unknown).toBeNull();
  });

  it("Office：docx/xlsx/pptx 各归各的渲染器", async () => {
    const registry = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");
    const zip = [0x50, 0x4b, 0x03, 0x04];
    const cases: [string, string][] = [
      ["a.docx", "word"],
      ["a.xlsx", "sheet"],
      ["a.xls", "sheet"],
      ["a.csv", "sheet"],
      ["a.pptx", "slides"],
    ];
    for (const [name, expected] of cases) {
      const ext = name.split(".").pop()!;
      const hit = await registry.resolvePreview({ root: "/r", rel: name, name, ext }, async () => bytes(zip));
      expect(hit?.id, `${name} 应交给 ${expected}`).toBe(expected);
    }
  });

  it("真实 CSV（纯文本，不是 zip）仍归 sheet —— 曾被「表格要求 zip 头」挡住", async () => {
    const registry = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");
    const csv = new TextEncoder().encode("name,age\n张三,30\n");
    const hit = await registry.resolvePreview({ root: "/r", rel: "a.csv", name: "a.csv", ext: "csv" }, async () => csv);
    expect(hit?.id).toBe("sheet");
    const tsv = new TextEncoder().encode("a\tb\n");
    const hit2 = await registry.resolvePreview({ root: "/r", rel: "a.tsv", name: "a.tsv", ext: "tsv" }, async () => tsv);
    expect(hit2?.id, "tsv 也应归 sheet").toBe("sheet");
  });

  it("注册表列出批次 1–4 的格式", async () => {
    // 注意：`vi.resetModules()` 会重置模块注册表，所以**所有**引用都必须走动态导入，
    // 否则顶层静态导入拿到的是另一个模块实例（第一版就是这么写错的：列表读出来是空的）。
    const registry = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");
    expect(registry.registeredPreviews().map((d) => d.id)).toEqual([
      "text",
      "pdf",
      "archive",
      "email",
      "word",
      "sheet",
      "slides",
      "ofd",
      "epub",
      "xps",
      "xmind",
      "drawio",
      "audio",
      "video",
      "lrc",
      "model3d",
      "cad",
      "gis",
    ]);
  });

  it("空注册表时返回 null（不抛）", async () => {
    const registry = await import("../src/knowledge/preview/registry");
    expect(registry.registeredPreviews()).toEqual([]);
    const none = await registry.resolvePreview(
      { root: "/r", rel: "a.pdf", name: "a.pdf", ext: "pdf" },
      async () => bytes([0x25, 0x50, 0x44, 0x46]),
    );
    expect(none).toBeNull();
  });

  it("registerPreview 可追加（新格式只改一处）", async () => {
    const registry = await import("../src/knowledge/preview/registry");
    registry.registerPreview({
      load: async () => ({ id: "demo", extensions: ["demo"], async render() {} }),
      describe: { id: "demo", extensions: ["demo"] },
    });
    const hit = await registry.resolvePreview(
      { root: "/r", rel: "x.demo", name: "x.demo", ext: "demo" },
      async () => bytes([]),
    );
    expect(hit?.id).toBe("demo");
  });
});
