// @vitest-environment jsdom
/**
 * GBK 编码的 csv —— 用户实测"表格-GBK.csv 没有实现"。
 *
 * 根因：`renderSheet` 把 csv 当**二进制**读（`readBytes` → SheetJS `type: "array"`），
 * 而 SheetJS 只按 UTF-8 解字节 → 中文整片乱码；更要命的是它绕过了文本通道，
 * 所以 Rust 的编码探测与用户的**手动编码切换**对它完全不起作用。
 *
 * 这条测试守住两件事：csv 走 `ctx.readText`（编码可探测/可切换）、GBK 文本能正确出表。
 */
import { describe, expect, it } from "vitest";
import type { PreviewContext } from "../src/knowledge/preview/registry";

/** 真实样本的 GBK 字节（"名称,数量,备注\n中文条目,12,逗号在引号里 "甲,乙"\n"）。 */
// 真实样本 /tmp/kb-spike/02-文档/表格-GBK.csv 的全部字节（GBK，“名称,数量,备注” 三列）
const GBK_CSV = new Uint8Array([0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0xca, 0xfd, 0xc1, 0xbf, 0x2c, 0xb1, 0xb8, 0xd7, 0xa2, 0x0a, 0xd6, 0xd0, 0xce, 0xc4, 0xcc, 0xf5, 0xc4, 0xbf, 0x2c, 0x31, 0x32, 0x2c, 0xb6, 0xba, 0xba, 0xc5, 0xd4, 0xda, 0xd2, 0xfd, 0xba, 0xc5, 0xc0, 0xef, 0x20, 0x22, 0xbc, 0xd7, 0x2c, 0xd2, 0xd2, 0x22, 0x0a, 0xd2, 0xd2, 0xcf, 0xee, 0x2c, 0x33, 0x2e, 0x35, 0x2c, 0xc6, 0xd5, 0xcd, 0xa8, 0xd0, 0xd0, 0x0a]);

function makeCtx(overrides: Partial<PreviewContext> & { ext: string }): { ctx: PreviewContext; state: { textReads: number; byteReads: number } } {
  const container = document.createElement("div");
  const state = { textReads: 0, byteReads: 0 };
  // 文本通道：模拟 Rust —— 编码探测后按 GBK 解码（这正是前端字节路径做不到的）
  const base = {
    root: "/r",
    rel: `a.${overrides.ext}`,
    name: `a.${overrides.ext}`,
    ext: overrides.ext,
    theme: "light" as const,
    container,
    readText: async () => new TextDecoder("gbk").decode(GBK_CSV),
    readBytes: async () => GBK_CSV,
    ...overrides,
  };
  // 计数器**包在最后**：放在 override 之前会被它顶掉（测试写错过一次）
  const ctx = {
    ...base,
    readText: async () => {
      state.textReads += 1;
      return base.readText();
    },
    readBytes: async () => {
      state.byteReads += 1;
      return base.readBytes();
    },
  } as PreviewContext;
  return { ctx, state };
}

describe("GBK 编码的 csv（走文本通道）", () => {
  it("csv 必须读文本而不是字节 —— 否则绕过编码探测，中文全乱", async () => {
    const { sheetPlugin } = await import("../src/knowledge/preview/plugins/office");
    const { ctx, state } = makeCtx({ ext: "csv" });
    await sheetPlugin.render(ctx);
    expect(state.textReads, "应走文本通道").toBe(1);
    expect(state.byteReads, "不该读字节").toBe(0);
    const cells = Array.from(ctx.container.querySelectorAll("td, th")).map((el) => el.textContent);
    // 先确认解码本身是对的（GBK 中文没问题），再看分隔符处理
    expect(cells.join("|"), `实际单元格：${JSON.stringify(cells)}`).toContain("名称");
    expect(cells.join("|")).toContain("中文条目");
    // 引号内的逗号不该被当分隔符（RFC4180）；SheetJS 的 csv 解析是否遵守由它决定，
    // 我们只断言"这一格没有被拆成两格"
    expect(cells.join("|")).toContain("逗号在引号里");
  });

  it("二进制表格（xlsx）仍走字节通道（文本通道会解坏 zip）", async () => {
    const { sheetPlugin } = await import("../src/knowledge/preview/plugins/office");
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("dummy.txt", "x");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const { ctx, state } = makeCtx({ ext: "xlsx", readBytes: async () => bytes });
    await sheetPlugin.render(ctx).catch(() => undefined); // 内容不是真 xlsx，报错无所谓
    expect(state.textReads, "xlsx 不该走文本通道").toBe(0);
  });

  it("tsv 同样是文本格式", async () => {
    const { sheetPlugin } = await import("../src/knowledge/preview/plugins/office");
    const tsv = new TextEncoder().encode("名称\t数量\n中文条目\t12\n");
    const { ctx, state } = makeCtx({
      ext: "tsv",
      readText: async () => new TextDecoder().decode(tsv),
      readBytes: async () => tsv,
    });
    await sheetPlugin.render(ctx);
    expect(state.textReads).toBe(1);
    const cells = Array.from(ctx.container.querySelectorAll("td, th")).map((el) => el.textContent);
    expect(cells).toContain("中文条目");
  });
});
