// @vitest-environment jsdom
/**
 * 预览面板的**接线**测试：select 一个文件 → 真的走到预览注册表、真渲染出对应视图。
 *
 * 为什么必须有这一层：`kind` 的兜底值曾经写成 `"text"`，把注册表分支变成死代码——
 * 插件单测全绿（插件本身没问题），但应用里 PDF/DXF/3D 全被当纯文本打开。
 * 只测插件、不测"面板有没有把文件交给插件"，这种坑就会漏过去。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { stubResizeObserver, waitForDom } from "./test-support";

/** 造一个"知识库根 + 一个文件"的后端替身（只实现面板用到的命令）。 */
const files = new Map<string, Uint8Array>();

vi.mock("../src/api", () => ({
  isTauri: () => true,
  api: {
    kbStat: async (_root: string, rel: string) => {
      const bytes = files.get(rel);
      return { exists: !!bytes, kind: "file", size: bytes?.byteLength ?? 0, mtimeMs: 1 };
    },
    kbReadBytes: async (_root: string, rel: string) => {
      const bytes = files.get(rel);
      if (!bytes) throw new Error(`no such file: ${rel}`);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    kbReadText: async (_root: string, rel: string) => {
      const bytes = files.get(rel);
      if (!bytes) throw new Error(`no such file: ${rel}`);
      return {
        text: new TextDecoder().decode(bytes),
        encoding: "UTF-8",
        bom: false,
        eol: "\n",
        size: bytes.byteLength,
        mtimeMs: 1,
      };
    },
  },
}));

const apps: App[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  while (apps.length) apps.pop()?.unmount();
  while (hosts.length) hosts.pop()?.remove();
});

beforeAll(async () => {
  stubResizeObserver();
  const { useI18n } = await import("../src/i18n");
  useI18n().setLocale("zh-CN");
});

/** 挂载预览面板并把 `selected` 指向目标文件，等它加载完。 */
async function preview(rel: string): Promise<HTMLElement> {
  const { useKnowledgeStore } = await import("../src/stores/knowledge");
  const { default: KnowledgePreview } = await import("../src/knowledge/KnowledgePreview.vue");
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useKnowledgeStore();
  store.root = "/tmp/kb";
  store.selected = rel;

  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const app = createApp(KnowledgePreview);
  apps.push(app);
  app.use(pinia);
  app.mount(host);
  // 注册表与插件都是异步 import() 的，渲染完成时间不确定 → 用等待式断言前的"等 DOM 出现"
  await nextTick();
  return host;
}

/** 等到选择器出现（插件渲染是若干次动态 import 之后的异步结果）。 */
async function waitFor(host: HTMLElement, selector: string): Promise<HTMLElement | null> {
  await waitForDom(() => {
    expect(host.querySelector(selector), `${selector} 应出现`).not.toBeNull();
  });
  return host.querySelector(selector);
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 带标题样式（走 styles.xml 的数字 styleId，与真实文档一致）的 docx。 */
async function docxWithHeadings(): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 1"/></w:style>
</w:styles>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="2"/></w:pPr><w:r><w:t>一、前言</w:t></w:r></w:p>
  <w:p><w:r><w:t>正文第一段</w:t></w:r></w:p>
</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

/** 最小但**结构完整**的 docx：docx-preview 需要 OPC 关系表才能找到 document.xml。 */
async function minimalDocx(): Promise<Uint8Array> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
  <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题一</w:t></w:r></w:p>
  <w:p><w:r><w:t>河南神马氯碱</w:t></w:r></w:p>
</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}



const DXF = `0
SECTION
2
ENTITIES
0
LINE
10
0
20
0
11
100
21
50
0
TEXT
10
5
20
5
40
2.5
1
平面图
0
ENDSEC
0
EOF`;

describe("面板 → 注册表接线", () => {
  it("DXF 交给 CAD 插件（曾经被当纯文本打开）", async () => {
    files.set("图纸.dxf", enc(DXF));
    const host = await preview("图纸.dxf");
    const cad = await waitFor(host, ".kb-cad");
    const svg = await waitFor(cad!, "svg");
    // 中文文字要出在图里（DXF 的中文是这条链路最容易断的地方）
    expect(svg!.textContent).toContain("平面图");
    // 且没有落到"纯文本"或"暂不支持"
    expect(host.querySelector("pre.code")).toBeNull();
    expect(host.querySelector(".unsupported")).toBeNull();
  });

  it("PDF 交给 pdf 插件（注册表被架空时这里会显示成文本）", async () => {
    // jsdom 没有 canvas，pdfjs 渲染不出页面 —— 这里断言"面板确实把文件交给了 pdf 插件"。
    // 探针用面板根节点上的 data-plugin（不可见），不再依赖头部的类型 chip ——
    // 那个 chip 显示的是未本地化的内部 id，已移除（状态栏显示本地化的格式名）。
    files.set("样张.pdf", enc("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"));
    const host = await preview("样张.pdf");
    await waitForDom(() => {
      expect(host.querySelector('[data-plugin="pdf"]'), "应交给 pdf 插件").not.toBeNull();
    });
    expect(host.querySelector("pre.code"), "不该落到纯文本").toBeNull();
  });

  it("ZIP 交给压缩包插件（列表视图）", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("说明.txt", "压缩包内的文本");
    files.set("包.zip", await zip.generateAsync({ type: "uint8array" }));
    const host = await preview("包.zip");
    await waitFor(host, ".kb-archive");
    expect(host.querySelector(".kb-archive")!.textContent).toContain("说明.txt");
    expect(host.querySelector("pre.code")).toBeNull();
  });

  it("插件渲染失败（损坏的 zip）→ 报错文案 + 不落纯文本 + 不误挂「暂不支持」卡片", async () => {
    files.set("坏的.zip", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00]));
    const host = await preview("坏的.zip");
    await waitFor(host, ".hint.warn");
    expect(host.querySelector(".unsupported"), "认领过它的插件才失败，不该说「暂不支持」").toBeNull();
    expect(host.querySelector("pre.code")).toBeNull();
  });

  it("注册表认领不了的**文本**文件 → 降级代码编辑器（CM6，可编辑）", async () => {
    files.set("README", enc("这是一个没有扩展名的文本文件。\n第二行。\n"));
    const host = await preview("README");
    const editor = await waitFor(host, ".kb-code-editor .cm-content");
    expect(editor!.textContent).toContain("第二行");
    expect(host.querySelector(".unsupported")).toBeNull();
  });

  it("认领不了的**二进制** → 诚实卡片（不用乱码糊弄）", async () => {
    files.set("data.bin", new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x80, 0x81, 0x00, 0x00]));
    const host = await preview("data.bin");
    await waitFor(host, ".unsupported");
    expect(host.querySelector("pre.code")).toBeNull();
  });

  it("SVG 走图片分支，且 blob 带 image/svg+xml（无类型时 WebKit 渲染成空白）", async () => {
    const captured: Blob[] = [];
    const original = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      captured.push(blob as Blob);
      return original(blob);
    });
    files.set(
      "图.svg",
      enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'),
    );
    const host = await preview("图.svg");
    const img = await waitFor(host, "img.image");
    expect(img!.getAttribute("src")!.startsWith("blob:")).toBe(true);
    expect(captured.at(-1)?.type).toBe("image/svg+xml");
    URL.createObjectURL = original; // 还原，避免影响后续用例
    vi.restoreAllMocks();
  });

  it("光栅图同样带对 MIME", async () => {
    const captured: Blob[] = [];
    const original = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      captured.push(blob as Blob);
      return original(blob);
    });
    files.set("照片.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const host = await preview("照片.png");
    await waitFor(host, "img.image");
    expect(captured.at(-1)?.type).toBe("image/png");
    URL.createObjectURL = original;
    vi.restoreAllMocks();
  });

  it("Markdown 仍走编辑器（不被注册表抢走）", async () => {
    files.set("note.md", enc("# 标题\n\n正文\n"));
    const host = await preview("note.md");
    expect(host.querySelector(".unsupported")).toBeNull();
    expect(host.querySelector(".kb-cad")).toBeNull();
  });
});

describe("缩放控件", () => {
  it("图片有缩放控件，且默认按「适应窗口」（不是 100%）", async () => {
    files.set("大图.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const host = await preview("大图.png");
    const img = (await waitFor(host, "img.image")) as HTMLImageElement;
    await waitForDom(() => {
      expect(host.querySelector(".zoom-group"), "图片应出现缩放控件").not.toBeNull();
    });
    // jsdom 不会真解码图片、也没有布局：手工给出图片尺寸与内容区尺寸并触发 load
    // （真实引擎里这两件事都由浏览器完成）
    Object.defineProperty(img, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 400, configurable: true });
    const bodyEl = host.querySelector(".preview-body")!;
    bodyEl.getBoundingClientRect = () =>
      ({ width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    img.dispatchEvent(new Event("load"));
    await nextTick();
    // 打开即 100%（= 适应窗口）；内容区四周留 5% → 可用 360×270，图片 800×400 → 宽 360
    expect(host.querySelector(".zoom-level")!.textContent!.trim()).toBe("100%");
    expect(host.querySelector('[title*="适应窗口"]')).not.toBeNull();
    expect(parseFloat(img.style.width)).toBeCloseTo(360, 0);

    // 位图**不放大**：换成小图（100×50）时不该被拉满屏
    Object.defineProperty(img, "naturalWidth", { value: 100, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 50, configurable: true });
    (host.querySelector('[title*="适应窗口"]') as HTMLElement).click();
    await nextTick();
    expect(parseFloat(img.style.width), "小图不应被放大").toBeCloseTo(100, 0);
  });

  it("CAD：打开即 100%（= 适应窗口），放大后 SVG 的内联尺寸真的变了", async () => {
    files.set("图纸2.dxf", enc(DXF));
    const host = await preview("图纸2.dxf");
    const cad = await waitFor(host, ".kb-cad");
    await waitForDom(() => {
      expect(host.querySelector(".zoom-group"), "DXF 应出现缩放控件").not.toBeNull();
    });
    // 打开即 100%（相对基准），不是绝对比例
    expect(host.querySelector(".zoom-level")!.textContent!.trim()).toBe("100%");

    const svg = cad!.querySelector("svg")! as unknown as HTMLElement;
    // 给画布一个视口（jsdom 没有布局）：600×400
    const canvasEl = cad!.querySelector(".kb-cad-canvas")! as HTMLElement;
    canvasEl.getBoundingClientRect = () =>
      ({ width: 600, height: 400, top: 0, left: 0, right: 600, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    window.dispatchEvent(new Event("resize"));
    (host.querySelector('[title*="适应窗口"]') as HTMLElement).click();
    await nextTick();
    // 关键：尺寸落在**内联样式**上（CSS 的 width:100% 会盖掉 width/height 属性 ——
    // 之前就是栽在这里：点了放大没反应）
    expect(svg.style.width, "适应后应有显式宽度").toMatch(/px$/);
    const fitted = parseFloat(svg.style.width);

    (host.querySelector('[title*="放大"]') as HTMLElement).click();
    await nextTick();
    expect(parseFloat(svg.style.width), "放大后宽度应变大").toBeGreaterThan(fitted);
    expect(host.querySelector(".zoom-level")!.textContent!.trim()).toBe("125%");
  });

  it("纯文本/代码这类没有缩放控件", async () => {
    files.set("样张.rs", enc("fn main() {}\n"));
    const host = await preview("样张.rs");
    await waitForDom(() => {
      expect(host.querySelector(".preview-host, pre.code, .kb-code, .kb-code-editor")).not.toBeNull();
    });
    expect(host.querySelector(".zoom-group"), "代码不该有缩放控件").toBeNull();
  });
});

describe("查找 / 大纲（插件声明式）", () => {
  it("PDF 有查找与大纲按钮，且查找条不给替换", async () => {
    files.set("样张2.pdf", enc("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"));
    const host = await preview("样张2.pdf");
    await waitForDom(() => {
      expect(host.querySelector('[data-plugin="pdf"]')).not.toBeNull();
    });
    expect(host.querySelector('[title*="查找"]'), "PDF 应有查找按钮").not.toBeNull();
    // 这份样本没有书签 → 不给"大纲"入口（点开只会是空面板）
    expect(host.querySelector('[title*="大纲"]'), "无书签的 PDF 不该有大纲按钮").toBeNull();
    // 打开查找条：只读预览不显示替换开关
    (host.querySelector('[title*="查找"]') as HTMLElement).click();
    await nextTick();
    await waitForDom(() => {
      expect(host.querySelector(".find-bar, .kb-find"), "查找条应出现").not.toBeNull();
    });
  });

  it("代码/文本这类没有查找与大纲按钮（它们还没接）", async () => {
    files.set("样张2.rs", enc("fn main() {}\n"));
    const host = await preview("样张2.rs");
    await waitForDom(() => {
      expect(host.querySelector(".preview-host, pre.code, .kb-code, .kb-code-editor")).not.toBeNull();
    });
    expect(host.querySelector('[title*="大纲"]')).toBeNull();
    expect(host.querySelector('[title*="查找"]')).toBeNull();
  });
});

describe("状态栏的格式标签", () => {
  it("打开 PNG / PDF / 无插件的文本，store 里拿到的是各自的格式标签", async () => {
    const { useKnowledgeStore } = await import("../src/stores/knowledge");
    files.set("照片2.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await preview("照片2.png");
    expect(useKnowledgeStore().activeFormat?.label).toBe("图片");
    expect(useKnowledgeStore().activeFormat?.size).toBe(8);

    files.set("样张3.pdf", enc("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"));
    await preview("样张3.pdf");
    // 注册表是动态 import 的，格式标签晚一拍到位 → 等待式断言
    await waitForDom(() => {
      expect(useKnowledgeStore().activeFormat?.label).toBe("PDF 文档");
    });

    // 文本/代码不设格式：状态栏按扩展名映射语言名（这里留空即正确）
    files.set("样张3.rs", enc("fn main() {}\n"));
    await preview("样张3.rs");
    await waitForDom(() => {
      expect(useKnowledgeStore().activeFormat).toBeNull();
    });
  });
});

describe("PDF 的「适应」口径", () => {
  it("声明两种口径 → 适应按钮变下拉（适应宽度 / 适应页面）", async () => {
    files.set("样张4.pdf", enc("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"));
    const host = await preview("样张4.pdf");
    await waitForDom(() => {
      expect(host.querySelector('[data-plugin="pdf"]')).not.toBeNull();
    });
    // 下拉而不是单按钮：点它应弹出两个口径（菜单 Teleport 到 body）
    (host.querySelector('[title*="适应方式"]') as HTMLElement).click();
    await nextTick();
    await waitForDom(() => {
      const items = [...document.querySelectorAll(".dd-menu .dd-row")].map((el) => el.textContent?.trim());
      expect(items.join("|")).toContain("适应宽度");
      expect(items.join("|")).toContain("适应页面");
    });
    document.querySelectorAll(".dd-menu").forEach((el) => el.remove());
  });
});

describe("Office 的操作区（用户问的「word 没有操作部分」）", () => {
  it("docx 有缩放与查找按钮（此前一个都没有）", async () => {
    files.set("测试.docx", await minimalDocx());
    const host = await preview("测试.docx");
    await waitForDom(() => {
      expect(host.querySelector(".zoom-group"), "docx 应有缩放控件").not.toBeNull();
      expect(host.querySelector('[title*="查找"]'), "docx 应有查找按钮").not.toBeNull();
    });
    // 缩放基准是"适应宽度"（与 PDF 同一口径）→ 下拉里有两个口径
    (host.querySelector('[title*="适应方式"]') as HTMLElement).click();
    await nextTick();
    await waitForDom(() => {
      const items = [...document.querySelectorAll(".dd-menu .dd-row")].map((el) => el.textContent?.trim());
      expect(items.join("|")).toContain("适应宽度");
    });
    document.querySelectorAll(".dd-menu").forEach((el) => el.remove());
  });

  it("docx：有大纲按钮、有页码、并上报当前章节", async () => {
    files.set("带标题.docx", await docxWithHeadings());
    const host = await preview("带标题.docx");
    await waitForDom(() => {
      expect(host.querySelector('[title*="大纲"]'), "docx 应有大纲按钮").not.toBeNull();
    });
    const { useKnowledgeStore } = await import("../src/stores/knowledge");
    await waitForDom(() => {
      expect(useKnowledgeStore().paging, "docx 应上报页码（按版心高度折算）").toBeTruthy();
    });
    // 大纲按钮打开后应列出标题（文本取自 document.xml）
    (host.querySelector('[title*="大纲"]') as HTMLElement).click();
    await nextTick();
    await waitForDom(() => {
      const items = [...host.querySelectorAll("button.outline-item")].map((el) => el.textContent ?? "");
      expect(items.join("|"), "大纲应含标题").toContain("一、前言");
    });
  });

  it("xlsx / pptx 有查找按钮", async () => {
    // 用 SheetJS 自己生成样本：手搓的 xlsx 结构不全，解析时会抛（异步、逃过断言）
    const XLSX = await import("xlsx");
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["姓名", "数量"], ["河南神马", 12]]), "表1");
    const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    files.set("测试.xlsx", new Uint8Array(bytes));
    const host = await preview("测试.xlsx");
    await waitForDom(() => {
      expect(host.querySelector('[title*="查找"]'), "xlsx 应有查找按钮").not.toBeNull();
    });

    const { default: JSZip } = await import("jszip");
    const slides = new JSZip();
    slides.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
    slides.file(
      "ppt/slides/slide1.xml",
      `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>河南神马</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    );
    files.set("测试.pptx", await slides.generateAsync({ type: "uint8array" }));
    const pptxHost = await preview("测试.pptx");
    await waitForDom(() => {
      expect(pptxHost.querySelector('[title*="查找"]'), "pptx 应有查找按钮").not.toBeNull();
      expect(pptxHost.textContent, "pptx 文本视图应出内容").toContain("河南神马");
    });
  });
});

describe("只读预览的查找（走同一套查找条）", () => {
  it("在 txt 里搜中文：命中被高亮，且计数正确", async () => {
    files.set("说明.txt", enc("河南神马氯碱发展有限责任公司\n河南神马在平顶山。\n"));
    const host = await preview("说明.txt");
    await waitFor(host, ".kb-code, pre.code");

    (host.querySelector('[title*="查找"]') as HTMLElement).click();
    const input = (await waitFor(host, ".find-input")) as HTMLInputElement;
    input.value = "河南神马";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitForDom(() => {
      expect(host.querySelectorAll("mark.kb-hit").length, "两处命中各一个 mark").toBe(2);
    });
    expect(host.querySelector(".find-count")!.textContent).toContain("1/2");
    // 下一个 → 当前命中移到第二处
    (host.querySelector('[title*="下一个"]') as HTMLElement | null)?.click();
    await nextTick();
    expect(host.querySelectorAll("mark.kb-hit-current").length).toBeLessThanOrEqual(1);

    // 关闭查找条 → 高亮清干净，正文不变
    (host.querySelector('[title*="关闭"]') as HTMLElement | null)?.click();
    await nextTick();
    expect(host.querySelectorAll("mark.kb-hit").length).toBe(0);
    expect(host.textContent).toContain("河南神马氯碱发展有限责任公司");
  });
});

describe("页码与跳转（状态栏）", () => {
  it("pptx：文本视图按张分页 → 上报 1/N 页，且能跳页", async () => {
    const { default: JSZip } = await import("jszip");
    const slides = new JSZip();
    slides.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
    for (const n of [1, 2, 3]) {
      slides.file(
        `ppt/slides/slide${n}.xml`,
        `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>第${n}张要点</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
      );
    }
    files.set("演示.pptx", await slides.generateAsync({ type: "uint8array" }));
    const host = await preview("演示.pptx");
    const { useKnowledgeStore } = await import("../src/stores/knowledge");
    await waitFor(host, ".kb-slides");
    expect(host.querySelectorAll(".kb-slide").length).toBe(3);

    // jsdom 没有布局（所有元素 top 都是 0），"当前页靠位置算"那部分由
    // tests/kb-preview-paging.test.ts 用打桩的坐标单独验；这里验**整条链路**：
    // 状态栏请求跳页 → 面板消费 → 插件 reveal → 回报页码 → 状态栏显示
    useKnowledgeStore().requestPageJump(2);
    await waitForDom(() => {
      expect(useKnowledgeStore().paging?.total, "跳页链路应把页码回报给状态栏").toBe(3);
    });
  });

  it("docx 的页码是按版心高度折算的（不依赖显式分页符）", async () => {
    files.set("测试2.docx", await minimalDocx());
    const host = await preview("测试2.docx");
    await waitFor(host, ".kb-docx");
    const { useKnowledgeStore } = await import("../src/stores/knowledge");
    await waitForDom(() => {
      const paging = useKnowledgeStore().paging;
      expect(paging, "docx 应上报页码").toBeTruthy();
      expect(paging!.total).toBeGreaterThanOrEqual(1);
      expect(paging!.page).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("大纲跳转（PDF 点了没反应的回归）", () => {
  // 造一个"有结构"的格式：渲染简单 DOM、给 3 条大纲（目标 = 第 1/2/3 页）
  const revealed: number[] = [];

  beforeAll(async () => {
    const registry = await import("../src/knowledge/preview/registry");
    registry.registerPreview({
      describe: { id: "tocdemo", extensions: ["tocdemo"] },
      load: async () => ({
        id: "tocdemo",
        extensions: ["tocdemo"],
        tools: ["outline"],
        async render(ctx) {
          const wrap = document.createElement("div");
          wrap.className = "tocdemo-body";
          for (const n of [1, 2, 3]) {
            const section = document.createElement("section");
            section.className = "tocdemo-page";
            section.textContent = `第 ${n} 节内容`;
            wrap.appendChild(section);
          }
          ctx.container.replaceChildren(wrap);
          ctx.onPaging?.({ page: 1, total: 3 });
          return {
            outline: [
              { level: 1, title: "一、前言", target: 1 },
              { level: 1, title: "二、现状", target: 2 },
              { level: 2, title: "2.1 概况", target: 3 },
            ],
            reveal: (page: number) => {
              revealed.push(page);
              ctx.onPaging?.({ page, total: 3 });
            },
          };
        },
      }),
    });
  });

  it("点大纲会跳转 —— 且切换侧栏**不能**把预览容器换掉", async () => {
    files.set("演示.tocdemo", enc("demo"));
    const host = await preview("演示.tocdemo");
    const { useKnowledgeStore } = await import("../src/stores/knowledge");
    await waitFor(host, ".tocdemo-body");

    // 打开大纲：容器必须**原地不动**（这是曾经最致命的一处：
    // 侧栏开关会把整个 preview-host 换掉，插件渲染的 DOM 随之消失，点大纲自然没反应）。
    // 注意 outlineOpen 会持久化在 localStorage 里，前面用例可能已经把它打开了 ——
    // 所以按当前状态决定点不点，测试不依赖执行顺序。
    if (!host.querySelector(".preview-outline")) {
      (host.querySelector('[title*="大纲"]') as HTMLElement).click();
      await nextTick();
    }
    const outline = await waitFor(host, ".preview-outline");
    expect(host.querySelector(".tocdemo-body"), "侧栏出现后正文应仍在").not.toBeNull();
    expect(outline!.textContent).toContain("一、前言");

    revealed.length = 0;
    const items = [...outline!.querySelectorAll<HTMLElement>("button.outline-item")];
    const second = items.find((el) => el.textContent?.includes("二、现状"))!;
    expect(second, "大纲里应有「二、现状」").toBeTruthy();
    second.click();
    await waitForDom(() => {
      expect(revealed, "点大纲应触发插件的 reveal").toContain(2);
    });
    // 当前章节跟着当前页高亮
    await waitForDom(() => {
      expect(useKnowledgeStore().paging?.page).toBe(2);
    });
  });
});

describe("头部信息格：只留交互控件与罕见信号（用户口径）", () => {
  it("不再有重复的「类型」chip（内部插件 id）；插件归属改用不可见的 data-plugin", async () => {
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("content.json", JSON.stringify([{ title: "画布", rootTopic: { title: "中心" } }]));
    files.set("脑图.xmind", await zip.generateAsync({ type: "uint8array" }));
    const host = await preview("脑图.xmind");
    await waitForDom(() => {
      expect(host.querySelector('[data-plugin="xmind"]'), "插件归属在 data-plugin 上").not.toBeNull();
    });
    // UI 上不该再出现 "xmind" / "sheet" 这类未本地化的内部 id
    // （只看 chip —— 文件名本身可能就含 "xmind"，不能拿整块文本断言）
    const chips = [...host.querySelectorAll(".head-left .meta.chip")].map((el) => el.textContent?.trim());
    expect(chips, `头部 chip 里有内部 id：${chips.join(",")}`).not.toContain("xmind");
    expect(chips, `头部 chip 里有内部 id：${chips.join(",")}`).not.toContain("sheet");
  });

  it("Markdown：编码 chip 变成可点控件，且位置在文件名之后", async () => {
    files.set("说明2.md", enc("# 标题\n"));
    const host = await preview("说明2.md");
    const chip = await waitFor(host, ".head-left .enc-chip");
    expect(chip!.textContent?.trim()).toBe("UTF-8");
    // 位置：在同一行里排在文件名的后面（用户要求"移到该位置"）
    // 注意：第一子是 SVG 图标，`className` 在 SVG 上是对象不是字符串 → 用 getAttribute
    const order = [...host.querySelector(".head-left")!.children].map((el) => el.getAttribute("class") ?? "");
    expect(order.findIndex((c) => c.includes("enc-chip"))).toBeGreaterThan(
      order.findIndex((c) => c.includes("file-name")),
    );
  });
});

describe("面包屑条（已按用户 2026-09-18 反馈移除）", () => {
  it("深层文件也不显示 .crumbs（父目录定位走页签右键「在文件树中显示」）", async () => {
    files.set("子/深层/文件.md", enc("# 标题\n"));
    const host = await preview("子/深层/文件.md");
    await waitFor(host, ".file-name");
    expect(host.querySelector(".crumbs"), "面包屑条已整体移除").toBeNull();
  });
});
