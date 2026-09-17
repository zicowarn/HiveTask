// @vitest-environment jsdom
/**
 * 批次 3 插件：OFD / EPUB / XPS / XMind / drawio。
 *
 * 这一批全是"自己解包自己排版"的格式，最容易出的是**路径拼错、坐标单位错、
 * 章节顺序错**。所以测试不是在断言"函数被调用了"，而是**现场造一份真文件**
 * （JSZip 打包）→ 交给插件渲染 → 断言 DOM 里的文本、顺序与坐标。
 */
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewContext } from "../src/knowledge/preview/registry";

const enc = new TextEncoder();

/** 造一个 zip（键 → 文本内容）。 */
async function makeZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: "uint8array" });
}

interface CtxOptions {
  ext: string;
  name?: string;
  text?: string;
  bytes?: Uint8Array;
}

function makeCtx({ ext, name, text = "", bytes }: CtxOptions): PreviewContext & { container: HTMLElement } {
  const container = document.createElement("div");
  return {
    root: "/r",
    rel: name ?? `a.${ext}`,
    name: name ?? `a.${ext}`,
    ext,
    theme: "light",
    container,
    readBytes: async () => bytes ?? enc.encode(text),
    readText: async () => text,
  };
}

beforeEach(() => {
  vi.resetModules();
});

describe("批次 3 路由", () => {
  it("扩展名各归各的渲染器", async () => {
    const registry = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");
    const zip = [0x50, 0x4b, 0x03, 0x04];
    const cases: [string, string][] = [
      ["a.ofd", "ofd"],
      ["a.epub", "epub"],
      ["a.xps", "xps"],
      ["a.oxps", "xps"],
      ["a.xmind", "xmind"],
      ["a.drawio", "drawio"],
      ["a.dio", "drawio"],
    ];
    for (const [name, expected] of cases) {
      const ext = name.split(".").pop()!;
      const hit = await registry.resolvePreview({ root: "/r", rel: name, name, ext }, async () => new Uint8Array(zip));
      expect(hit?.id, `${name} 应交给 ${expected}`).toBe(expected);
    }
  });

});

describe("OFD：按毫米坐标排版", () => {
  const NS = 'xmlns:ofd="http://www.ofdspec.org/2016"';

  it("文本对象按 Boundary 定位、按 Size 定字号，页面按 PhysicalBox 定尺寸", async () => {
    const bytes = await makeZip({
      "OFD.xml": `<ofd:OFD ${NS}><ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`,
      "Doc_0/Document.xml": `<ofd:Document ${NS}><ofd:Pages><ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml" PhysicalBox="0 0 210 297"/></ofd:Pages></ofd:Document>`,
      "Doc_0/Pages/Page_0/Content.xml": `<ofd:Page ${NS}><ofd:TextObject Boundary="20 30 100 10" Size="3.5"><ofd:TextCode>测试公文</ofd:TextCode></ofd:TextObject></ofd:Page>`,
    });
    const { ofdPlugin } = await import("../src/knowledge/preview/plugins/ofd");
    const ctx = makeCtx({ ext: "ofd", bytes });
    await ofdPlugin.render(ctx);

    const span = ctx.container.querySelector<HTMLElement>(".kb-ofd-text")!;
    expect(span.textContent).toBe("测试公文");
    // 毫米 → 像素：1mm = 96/25.4 ≈ 3.7795px（保留亚像素，浏览器自行取整）
    const px = (mm: number): number => mm * (96 / 25.4);
    expect(parseFloat(span.style.left)).toBeCloseTo(px(20), 2);
    expect(parseFloat(span.style.top)).toBeCloseTo(px(30), 2);
    expect(parseFloat(span.style.fontSize)).toBeCloseTo(px(3.5), 2);
    // A4 页面尺寸（210 × 297mm）
    const page = ctx.container.querySelector<HTMLElement>(".kb-ofd-page")!;
    expect(parseFloat(page.style.width)).toBeCloseTo(px(210), 1);
    expect(parseFloat(page.style.height)).toBeCloseTo(px(297), 1);
  });

  it("前缀不写死 ofd:（各家生成器前缀不一，按本地名匹配）", async () => {
    const other = 'xmlns:ofd1="http://www.ofdspec.org/2016"';
    const bytes = await makeZip({
      "OFD.xml": `<ofd1:OFD ${other}><ofd1:DocBody><ofd1:DocRoot>Doc_0/Document.xml</ofd1:DocRoot></ofd1:DocBody></ofd1:OFD>`,
      "Doc_0/Document.xml": `<ofd1:Document ${other}><ofd1:Pages><ofd1:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/></ofd1:Pages></ofd1:Document>`,
      "Doc_0/Pages/Page_0/Content.xml": `<ofd1:Page ${other}><ofd1:TextObject Boundary="0 0 10 10" Size="3"><ofd1:TextCode>换个前缀</ofd1:TextCode></ofd1:TextObject></ofd1:Page>`,
    });
    const { ofdPlugin } = await import("../src/knowledge/preview/plugins/ofd");
    const ctx = makeCtx({ ext: "ofd", bytes });
    await ofdPlugin.render(ctx);
    expect(ctx.container.querySelector(".kb-ofd-text")!.textContent).toBe("换个前缀");
  });

  it("TextCode 多段拼接（OFD 把一行拆成多个 TextCode）", async () => {
    const bytes = await makeZip({
      "OFD.xml": `<ofd:OFD ${NS}><ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`,
      "Doc_0/Document.xml": `<ofd:Document ${NS}><ofd:Pages><ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/></ofd:Pages></ofd:Document>`,
      "Doc_0/Pages/Page_0/Content.xml": `<ofd:Page ${NS}><ofd:TextObject Boundary="0 0 10 10" Size="3"><ofd:TextCode>北京</ofd:TextCode><ofd:TextCode>市</ofd:TextCode></ofd:TextObject></ofd:Page>`,
    });
    const { ofdPlugin } = await import("../src/knowledge/preview/plugins/ofd");
    const ctx = makeCtx({ ext: "ofd", bytes });
    await ofdPlugin.render(ctx);
    expect(ctx.container.querySelector(".kb-ofd-text")!.textContent).toBe("北京市");
  });

  it("不是 OFD（无 OFD.xml）→ 抛出可读错误，而不是静默空白", async () => {
    const bytes = await makeZip({ "hello.txt": "hi" });
    const { ofdPlugin } = await import("../src/knowledge/preview/plugins/ofd");
    await expect(ofdPlugin.render(makeCtx({ ext: "ofd", bytes }))).rejects.toThrow(/OFD\.xml/);
  });

  it("页面列表为空 → 明确报错（加密/非标准实现），不出空白页", async () => {
    const bytes = await makeZip({
      "OFD.xml": `<ofd:OFD ${NS}><ofd:DocBody><ofd:DocRoot>Doc_0/Document.xml</ofd:DocRoot></ofd:DocBody></ofd:OFD>`,
      "Doc_0/Document.xml": `<ofd:Document ${NS}><ofd:Pages/></ofd:Document>`,
    });
    const { ofdPlugin } = await import("../src/knowledge/preview/plugins/ofd");
    await expect(ofdPlugin.render(makeCtx({ ext: "ofd", bytes }))).rejects.toThrow(/没有页面/);
  });
});

describe("EPUB：按 spine 顺序渲染章节", () => {
  async function epubZip(): Promise<Uint8Array> {
    return makeZip({
      "META-INF/container.xml": `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      "OEBPS/content.opf": `<package><manifest>
          <item id="c2" href="ch2.xhtml"/>
          <item id="c1" href="ch1.xhtml"/>
        </manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
      "OEBPS/ch1.xhtml": `<html><body><h1>第一章</h1><p>正文一</p></body></html>`,
      "OEBPS/ch2.xhtml": `<html><body><h1>第二章</h1><p>正文二</p></body></html>`,
    });
  }

  it("章节按 spine 排序（spine 说 c1 在前，manifest 里的顺序不算数）", async () => {
    const { epubPlugin } = await import("../src/knowledge/preview/plugins/ebook");
    const ctx = makeCtx({ ext: "epub", bytes: await epubZip() });
    await epubPlugin.render(ctx);
    const chapters = Array.from(ctx.container.querySelectorAll(".kb-epub-chapter")).map((el) => el.textContent);
    expect(chapters).toEqual(["第一章正文一", "第二章正文二"]);
  });

  it("章节内的脚本被清洗掉（ebook 是不可信输入）", async () => {
    const bytes = await makeZip({
      "META-INF/container.xml": `<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>`,
      "content.opf": `<package><manifest><item id="c1" href="ch1.xhtml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
      "ch1.xhtml": `<html><body><p>安全文本</p><script>window.__pwned = 1</script></body></html>`,
    });
    const { epubPlugin } = await import("../src/knowledge/preview/plugins/ebook");
    const ctx = makeCtx({ ext: "epub", bytes });
    await epubPlugin.render(ctx);
    expect(ctx.container.querySelector(".kb-epub-chapter")!.textContent).toContain("安全文本");
    expect(ctx.container.querySelector("script")).toBeNull();
  });

  it("OPF 缺失 → 可读错误", async () => {
    const bytes = await makeZip({ "META-INF/container.xml": `<container><rootfiles><rootfile full-path="nope.opf"/></rootfiles></container>` });
    const { epubPlugin } = await import("../src/knowledge/preview/plugins/ebook");
    await expect(epubPlugin.render(makeCtx({ ext: "epub", bytes }))).rejects.toThrow(/OPF/);
  });
});

describe("XPS：固定版式文本抽取", () => {
  it("按 Documents/N/Pages/M.fpage 顺序列出页面文本", async () => {
    const bytes = await makeZip({
      "Documents/1/Pages/1.fpage": `<FixedPage><Glyphs UnicodeString="第一页内容"/></FixedPage>`,
      "Documents/1/Pages/2.fpage": `<FixedPage><Glyphs UnicodeString="第二页内容"/></FixedPage>`,
    });
    const { xpsPlugin } = await import("../src/knowledge/preview/plugins/ebook");
    const ctx = makeCtx({ ext: "xps", bytes });
    await xpsPlugin.render(ctx);
    const pages = Array.from(ctx.container.querySelectorAll(".kb-xps-text")).map((el) => el.textContent);
    expect(pages).toEqual(["第一页内容", "第二页内容"]);
  });

  it("空页（没有 Glyphs）也要出页框，只是标注无文本", async () => {
    const bytes = await makeZip({ "Documents/1/Pages/1.fpage": `<FixedPage></FixedPage>` });
    const { xpsPlugin } = await import("../src/knowledge/preview/plugins/ebook");
    const ctx = makeCtx({ ext: "xps", bytes });
    await xpsPlugin.render(ctx);
    expect(ctx.container.querySelectorAll(".kb-xps-page").length).toBe(1);
    expect(ctx.container.textContent).toContain("没有可提取的文本");
  });
});

describe("XMind：层级还原", () => {
  it("content.json 的根主题与子主题按层级渲染", async () => {
    const content = [
      {
        title: "画布 1",
        rootTopic: {
          title: "中心主题",
          children: { attached: [{ title: "分支 A", children: { attached: [{ title: "叶子" }] } }, { title: "分支 B" }] },
        },
      },
    ];
    const { xmindPlugin } = await import("../src/knowledge/preview/plugins/ebook");
    const ctx = makeCtx({ ext: "xmind", bytes: await makeZip({ "content.json": JSON.stringify(content) }) });
    await xmindPlugin.render(ctx);
    const topics = Array.from(ctx.container.querySelectorAll(".kb-xmind-topic")).map(
      (el) => el.firstChild?.textContent,
    );
    expect(topics).toEqual(["中心主题", "分支 A", "叶子", "分支 B"]);
    // 层级：叶子比分支深一级
    expect(ctx.container.querySelectorAll(".kb-xmind-topic.depth-2").length).toBe(1);
  });

  it("旧版 XMind（无 content.json）→ 明确报错，而不是空画布", async () => {
    const { xmindPlugin } = await import("../src/knowledge/preview/plugins/ebook");
    const ctx = makeCtx({ ext: "xmind", bytes: await makeZip({ "content.xml": "<xmap-content/>" }) });
    await expect(xmindPlugin.render(ctx)).rejects.toThrow(/content\.json/);
  });
});

describe("drawio：顶点框", () => {
  it("顶点按 mxGeometry 定位，标签去 HTML 标签", async () => {
    const xml = `<mxfile><diagram><mxGraphModel><root>
      <mxCell id="2" value="开始" vertex="1"><mxGeometry x="0" y="0" width="120" height="40" as="geometry"/></mxCell>
      <mxCell id="3" value="&lt;b&gt;结束&lt;/b&gt;" vertex="1"><mxGeometry x="200" y="80" width="120" height="40" as="geometry"/></mxCell>
      <mxCell id="4" edge="1" source="2" target="3"><mxGeometry as="geometry"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    const { drawioPlugin } = await import("../src/knowledge/preview/plugins/ebook");
    const ctx = makeCtx({ ext: "drawio", text: xml });
    await drawioPlugin.render(ctx);
    const boxes = Array.from(ctx.container.querySelectorAll<HTMLElement>(".kb-drawio-box"));
    expect(boxes.map((el) => el.textContent)).toEqual(["开始", "结束"]);
    expect(boxes[1].style.left).toBe("220px"); // 200 + 20 边距
    expect(boxes[1].style.top).toBe("100px");
  });
});
