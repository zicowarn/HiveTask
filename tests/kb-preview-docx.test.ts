// @vitest-environment jsdom
/**
 * docx 的大纲与页码。
 *
 * 大纲抽取的**真实数据模型**（取自用户的方案书）：
 *   - `word/styles.xml` 里 `styleId="2"` → `w:name w:val="heading 1"`、`w:outlineLvl w:val="1"`
 *   - 正文写作 `w:pStyle w:val="2"` —— **不是** `Heading1`
 * 所以只认字面量 `Heading1` 的实现，在真实文档上会一个字都抽不出来。
 */
import { describe, expect, it } from "vitest";
import { mapHeadingsToDom, pageAt, parseDocxHeadings } from "../src/knowledge/preview/plugins/office";

const STYLES = `<?xml version="1.0"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="3"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="5"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="标题 3"><w:name w:val="标题 3"/></w:style>
</w:styles>`;

const para = (styleId: string, text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

const DOC = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${para("2", "一、前言")}
    ${para("5", "正文正文正文")}
    ${para("3", "1.1 项目背景")}
    ${para("5", "更多正文")}
    ${para("2", "二、企业现状")}
    <w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>直接标大纲级别的段落</w:t></w:r></w:p>
    ${para("标题 3", "中文样式名也要认")}
  </w:body>
</w:document>`;

describe("docx 大纲抽取", () => {
  it("经 styles.xml 把数字 styleId 映射成标题级别（真实文档就是这么写的）", () => {
    const headings = parseDocxHeadings(DOC, STYLES);
    expect(headings.map((h) => [h.level, h.title])).toEqual([
      [1, "一、前言"],
      [2, "1.1 项目背景"],
      [1, "二、企业现状"],
      [1, "直接标大纲级别的段落"],
      [3, "中文样式名也要认"],
    ]);
  });

  it("正文段落不会被当标题", () => {
    const headings = parseDocxHeadings(DOC, STYLES);
    expect(headings.some((h) => h.title.includes("正文"))).toBe(false);
  });

  it("没有 styles.xml 时退化为空，不抛错", () => {
    expect(parseDocxHeadings(DOC, "")).toEqual([
      { level: 1, title: "直接标大纲级别的段落" },
    ]);
  });
});

describe("标题 → 渲染 DOM 的映射", () => {
  const host = (texts: string[]) => {
    const el = document.createElement("div");
    for (const text of texts) {
      const p = document.createElement("p");
      p.textContent = text;
      el.appendChild(p);
    }
    return el;
  };

  it("按顺序映射；重复标题不会全指到第一个", () => {
    const el = host(["一、前言", "正文", "小结", "正文", "小结"]);
    const els = mapHeadingsToDom(el, [
      { level: 1, title: "小结" },
      { level: 1, title: "小结" },
    ]);
    expect(els.length).toBe(2);
    expect(els[0]).not.toBe(els[1]);
    expect(els[0].textContent).toBe("小结");
    expect(els[1].textContent).toBe("小结");
  });

  it("DOM 里找不到的标题被跳过（不产生悬空条目）", () => {
    const el = host(["一、前言"]);
    const els = mapHeadingsToDom(el, [
      { level: 1, title: "一、前言" },
      { level: 1, title: "不存在的标题" },
    ]);
    expect(els.length).toBe(1);
  });
});

describe("按版心高度折算页码", () => {
  it("总页数 = 内容高度 ÷ 一页高度，向上取整", () => {
    expect(pageAt(1000, 1000, 0)).toEqual({ page: 1, total: 1 });
    expect(pageAt(1500, 1000, 0)).toEqual({ page: 1, total: 2 });
    expect(pageAt(3000, 1000, 0)).toEqual({ page: 1, total: 3 });
  });

  it("当前页随滚动位置走，且夹在 1..total 内", () => {
    expect(pageAt(3000, 1000, 0).page).toBe(1);
    expect(pageAt(3000, 1000, 999).page).toBe(1);
    expect(pageAt(3000, 1000, 1000).page).toBe(2);
    expect(pageAt(3000, 1000, 2999).page).toBe(3);
    expect(pageAt(3000, 1000, 99999).page).toBe(3); // 夹住
    expect(pageAt(3000, 1000, -50).page).toBe(1);
  });

  it("尺寸还没量出来时给 1/1，不产生 NaN", () => {
    expect(pageAt(0, 1000, 0)).toEqual({ page: 1, total: 1 });
    expect(pageAt(1000, 0, 0)).toEqual({ page: 1, total: 1 });
  });
});
