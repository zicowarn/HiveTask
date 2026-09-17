// @vitest-environment jsdom
/**
 * gzip 系（`.gz` 单文件 / `.tar.gz` 打包）—— 审计发现"声明了却没实现也没注册"的悬空项。
 *
 * 用真 tar 字节流验证（自己按 512 字节块拼），而不是 mock 解析器。
 */
import { describe, expect, it } from "vitest";
import { gzip } from "pako";
import type { PreviewContext } from "../src/knowledge/preview/registry";
import { parseTar } from "../src/knowledge/preview/plugins/archive";

/** 造一条 tar 记录（名字 + 内容 + mtime）。 */
function tarEntry(name: string, content: string, mtime = 0): Uint8Array {
  const header = new Uint8Array(512);
  const encoder = new TextEncoder();
  header.set(encoder.encode(name).subarray(0, 100), 0);
  const octal = (value: number, length: number, offset: number): void => {
    header.set(encoder.encode(value.toString(8).padStart(length - 1, "0")), offset);
  };
  octal(0o644, 8, 100); // mode
  octal(0, 8, 108); // uid
  octal(0, 8, 116); // gid
  octal(content.length, 12, 124); // size
  octal(mtime, 12, 136); // mtime
  header[156] = 0x30; // typeflag '0' = 普通文件
  header.set(encoder.encode("ustar"), 257);
  const body = new Uint8Array(Math.ceil(content.length / 512) * 512);
  body.set(encoder.encode(content), 0);
  return new Uint8Array([...header, ...body]);
}

const tarBytes = (...parts: Uint8Array[]): Uint8Array => {
  const end = new Uint8Array(1024); // 两个全零块 = 结束
  return new Uint8Array([...parts.flatMap((part) => [...part]), ...end]);
};

function makeCtx(bytes: Uint8Array, ext: string): PreviewContext {
  const container = document.createElement("div");
  return {
    root: "/r",
    rel: `a.${ext}`,
    name: `a.${ext}`,
    ext,
    theme: "light",
    container,
    readBytes: async () => bytes,
    readText: async () => "",
  };
}

describe("tar 解析", () => {
  it("文件名 / 大小 / 时间都对，且按 512 对齐跳到下一条", () => {
    const bytes = tarBytes(
      tarEntry("readme.md", "hello", 1_700_000_000),
      tarEntry("src/main.ts", "x".repeat(600), 1_700_000_000),
    );
    const entries = parseTar(bytes);
    expect(entries.map((entry) => [entry.name, entry.size])).toEqual([
      ["readme.md", 5],
      ["src/main.ts", 600],
    ]);
    expect(entries[0].mtime).toBe(1_700_000_000_000);
  });
});

describe("gzip / tgz 渲染", () => {
  it(".tgz：列出 tar 条目", async () => {
    const { archivePlugin } = await import("../src/knowledge/preview/plugins/archive");
    const bytes = gzip(tarBytes(tarEntry("a.md", "A"), tarEntry("b/c.txt", "BC")));
    const ctx = makeCtx(bytes, "tgz");
    await archivePlugin.render(ctx);
    const names = Array.from(ctx.container.querySelectorAll(".kb-archive-name")).map((el) => el.textContent);
    expect(names).toEqual(["a.md", "b/c.txt"]);
    expect(ctx.container.textContent).toContain("共 2 个条目");
  });

  it(".gz 单文件：能按文本显示就显示内容", async () => {
    const { archivePlugin } = await import("../src/knowledge/preview/plugins/archive");
    const ctx = makeCtx(gzip(new TextEncoder().encode("河南神马\n第二行")), "gz");
    await archivePlugin.render(ctx);
    expect(ctx.container.querySelector("pre")?.textContent).toContain("河南神马");
  });

  it(".gz 里的二进制：说明无法按文本显示，不硬塞乱码", async () => {
    const { archivePlugin } = await import("../src/knowledge/preview/plugins/archive");
    const ctx = makeCtx(gzip(new Uint8Array([0x00, 0x01, 0x02, 0xff])), "gz");
    await archivePlugin.render(ctx);
    expect(ctx.container.textContent).toContain("无法按文本显示");
  });

  it("损坏的 gzip → 可读报错", async () => {
    const { archivePlugin } = await import("../src/knowledge/preview/plugins/archive");
    await expect(archivePlugin.render(makeCtx(new Uint8Array([0x1f, 0x8b, 0xff]), "gz"))).rejects.toThrow(/gzip/);
  });
});
