// @vitest-environment jsdom
/**
 * ODF（odt/odp）自研解析：**与 OOXML 结构不同**，所以不能复用 docx 那套。
 *
 * 审计发现的问题：`.odt` 以前没有任何插件认领（会落到压缩包列表）。这里守住三件事：
 * 段落不被粘成一行（`textContent` 会跨段拼接）、标题层级进大纲、表格按行列还原。
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import type { PreviewContext } from "../src/knowledge/preview/registry";
import { parseOdfBody } from "../src/knowledge/preview/plugins/odf";

const NS = `xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"`;

const wrapContent = (body: string) =>
  `<?xml version="1.0"?><office:document-content ${NS}><office:body>${body}</office:body></office:document-content>`;

const textDoc = (inner: string) => wrapContent(`<office:text>${inner}</office:text>`);

function makeCtx(bytes: Uint8Array, ext = "odt"): PreviewContext {
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

async function zipOf(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array" });
}

describe("ODF 正文解析", () => {
  it("标题带层级、段落逐个成块（不粘行）", () => {
    const blocks = parseOdfBody(
      textDoc(
        `<text:h text:outline-level="1">第一章</text:h><text:p>正文一段</text:p><text:p>正文二段</text:p>`,
      ),
    );
    expect(blocks.map((b) => [b.kind, b.level ?? null, b.text])).toEqual([
      ["heading", 1, "第一章"],
      ["paragraph", null, "正文一段"],
      ["paragraph", null, "正文二段"],
    ]);
  });

  it("列表逐项、表格按行列", () => {
    const blocks = parseOdfBody(
      textDoc(
        `<text:list><text:list-item><text:p>其一</text:p></text:list-item><text:list-item><text:p>其二</text:p></text:list-item></text:list>
         <text:table><table:table>
           <table:table-row><table:table-cell><text:p>甲</text:p></table:table-cell><table:table-cell><text:p>乙</text:p></table:table-cell></table:table-row>
         </table:table></text:table>`,
      ),
    );
    expect(blocks[0]).toMatchObject({ kind: "list", items: [["其一"], ["其二"]] });
    expect(blocks[1]).toMatchObject({ kind: "table", items: [["甲", "乙"]] });
  });

  it("`<text:s/>` 的空格与 `<text:line-break/>` 的换行都还原", () => {
    const blocks = parseOdfBody(textDoc(`<text:p>A<text:s text:c="3"/>B<text:line-break/>C</text:p>`));
    expect(blocks[0].text).toBe("A   B\nC");
  });
});

describe("ODF 渲染（接线）", () => {
  it("odt：渲染出标题/段落，并给出大纲与跳转目标", async () => {
    const { odfTextPlugin } = await import("../src/knowledge/preview/plugins/odf");
    const bytes = await zipOf({
      "content.xml": textDoc(`<text:h text:outline-level="1">第一章 前言</text:h><text:p>正文</text:p>`),
    });
    const ctx = makeCtx(bytes);
    const instance = await odfTextPlugin.render(ctx);
    expect(ctx.container.querySelector("h1")?.textContent).toBe("第一章 前言");
    expect(instance.outline).toEqual([{ level: 1, title: "第一章 前言", target: 1 }]);
    instance.reveal?.(1); // 不该抛
  });

  it("空的 ODF 正文 → 说明情况，而不是空白", async () => {
    const { odfTextPlugin } = await import("../src/knowledge/preview/plugins/odf");
    const ctx = makeCtx(await zipOf({ "content.xml": wrapContent("") }));
    await odfTextPlugin.render(ctx);
    expect(ctx.container.textContent).toContain("没有可显示的正文");
  });

  it("odp：按页分块 + 页列表大纲 + 页码上报", async () => {
    const { odfSlidesPlugin } = await import("../src/knowledge/preview/plugins/odf");
    const pages = [1, 2]
      .map(
        (n) =>
          `<draw:page><text:p>第${n}页标题</text:p><text:p>要点${n}</text:p></draw:page>`,
      )
      .join("");
    const ctx = makeCtx(
      await zipOf({
        "content.xml": wrapContent(
          `<office:presentation xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0">${pages}</office:presentation>`,
        ),
      }),
      "odp",
    );
    const instance = await odfSlidesPlugin.render(ctx);
    expect(ctx.container.querySelectorAll(".kb-slide").length).toBe(2);
    expect(instance.outline?.map((item) => item.title)).toEqual(["第1页标题", "第2页标题"]);
  });
});
