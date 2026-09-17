// @vitest-environment jsdom
/**
 * 预览路由判定（`previewKind`）—— **这一条曾经把整个注册表架空**：
 * 面板末尾写的是 `return "text"`，于是 PDF / Office / OFD / DXF / 3D 全被当纯文本打开，
 * `kind === "other"` 的注册表分支成了死代码。插件再多也一个都跑不到。
 *
 * 所以这里守的不是"函数返回对不对"，而是**这条分工不许再被兜底值吞掉**。
 */
import { describe, expect, it } from "vitest";
import {
  imageMimeFor,
  looksLikeText,
  previewKind,
  TEXT_FALLBACK_MAX_BYTES,
} from "../src/knowledge/preview/kind";

describe("预览路由", () => {
  it("Markdown 走编辑器", () => {
    for (const ext of ["md", "markdown", "mdx"]) expect(previewKind(ext), ext).toBe("markdown");
  });

  it("图片走 <img>（含 SVG）", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"]) {
      expect(previewKind(ext), ext).toBe("image");
    }
  });

  it("其余一律交给预览注册表 —— 不得落到纯文本", () => {
    const registryOwned = [
      "pdf",
      "docx",
      "xlsx",
      "csv",
      "pptx",
      "ofd",
      "epub",
      "xps",
      "xmind",
      "drawio",
      "zip",
      "eml",
      "mp3",
      "mp4",
      "m3u8",
      "lrc",
      "glb",
      "gltf",
      "stl",
      "dxf",
      "dwg",
      "geojson",
      "kml",
      "gpx",
      "shp",
      "rs",
      "ts",
      "json",
      "txt",
      "", // 无扩展名（README / Makefile）：先问注册表，认领不了再降级文本
    ];
    for (const ext of registryOwned) {
      expect(previewKind(ext), `.${ext} 应交给注册表`).toBe("other");
    }
  });

  it("注册表认领不了 + 内容是文本 → 才降级为纯文本", () => {
    expect(previewKind("logo.unknown-ext", true)).toBe("text");
    // 降级标记不能反过来把 Markdown / 图片抢走
    expect(previewKind("md", true)).toBe("markdown");
    expect(previewKind("svg", true)).toBe("image");
  });
});

describe("文本判定", () => {
  it("正常文本 / 空文本算文本", () => {
    expect(looksLikeText("hello 世界\n第二行")).toBe(true);
    expect(looksLikeText("")).toBe(true);
  });

  it("含 NUL → 二进制", () => {
    expect(looksLikeText("PK\u0003\u0004\u0000\u0000")).toBe(false);
  });

  it("大面积替换字符 → 二进制（被按文本解码的二进制长这样）", () => {
    // 二进制被解码后：替换字符占比远高于 5%
    const garbage = `${"\uFFFD".repeat(40)}PK\u0003${"\uFFFD".repeat(60)}`;
    expect(looksLikeText(garbage)).toBe(false);
    expect(looksLikeText("\uFFFD".repeat(200) + "abc")).toBe(false);
  });

  it("偶发坏字节的文本不该被判成二进制（中文文件里常见）", () => {
    expect(looksLikeText("这是一段正常的中文文本，只有一处 \uFFFD 异常，其余都好。")).toBe(true);
    // 短样本上的单点噪声也不作数
    expect(looksLikeText("a\uFFFDb")).toBe(true);
  });

  it("降级有体积上限（超上限直接给不支持卡片，不赌）", () => {
    expect(TEXT_FALLBACK_MAX_BYTES).toBeGreaterThan(1024 * 1024);
    expect(TEXT_FALLBACK_MAX_BYTES).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});

describe("图片 MIME", () => {
  it("SVG 必须给 image/svg+xml —— 无类型的 blob 在 WebKit 下渲染成空白", () => {
    expect(imageMimeFor("svg")).toBe("image/svg+xml");
    expect(imageMimeFor("png")).toBe("image/png");
    expect(imageMimeFor("jpg")).toBe("image/jpeg");
    expect(imageMimeFor("jpeg")).toBe("image/jpeg");
    expect(imageMimeFor("webp")).toBe("image/webp");
  });

  it("未知扩展名给中性类型（不猜）", () => {
    expect(imageMimeFor("xyz")).toBe("application/octet-stream");
  });
});

describe("状态栏的「文件格式」文案", () => {
  it("文本/代码交给语言映射（返回空 key），不抢状态栏的活", async () => {
    const { formatLabelKey } = await import("../src/knowledge/preview/kind");
    expect(formatLabelKey("md", "markdown", null)).toBe("");
    expect(formatLabelKey("rs", "other", "text")).toBe("");
    expect(formatLabelKey("", "other", "text")).toBe("");
  });

  it("二进制格式给准确名字（曾经一律显示「纯文本」）", async () => {
    const { formatLabelKey } = await import("../src/knowledge/preview/kind");
    expect(formatLabelKey("pdf", "other", "pdf")).toBe("kb.format.pdf");
    expect(formatLabelKey("docx", "other", "word")).toBe("kb.format.word");
    expect(formatLabelKey("xlsx", "other", "sheet")).toBe("kb.format.sheet");
    expect(formatLabelKey("dxf", "other", "cad")).toBe("kb.format.cad");
    expect(formatLabelKey("zip", "other", "archive")).toBe("kb.format.archive");
  });

  it("图片按矢量/位图分开叫", async () => {
    const { formatLabelKey } = await import("../src/knowledge/preview/kind");
    expect(formatLabelKey("png", "image", null)).toBe("kb.format.image");
    expect(formatLabelKey("svg", "image", null)).toBe("kb.format.svg");
  });
});
