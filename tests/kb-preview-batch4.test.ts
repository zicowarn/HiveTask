// @vitest-environment jsdom
/**
 * 批次 4 插件：媒体（音视频/LRC）、3D、CAD、GIS。
 *
 * 重点守三类**会真出问题**的点：
 * ① 路由——`m3u8` 不能被当普通文本、`dxf` 不能被代码高亮接走；
 * ② 纯函数解析——LRC 时间标签、DXF 实体/转义/编码，这些错了画出来就是错的；
 * ③ 诚实降级——解不了的编码、认不出但不做的格式，必须落地区（note），不能空画布。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitForDom } from "./test-support";
import type { PreviewContext } from "../src/knowledge/preview/registry";

const enc = new TextEncoder();

function makeCtx(partial: Partial<PreviewContext> & { ext: string }): PreviewContext {
  const name = partial.name ?? `a.${partial.ext}`;
  return {
    root: "/r",
    rel: partial.rel ?? name,
    name,
    ext: partial.ext,
    theme: "light",
    container: document.createElement("div"),
    readBytes: async () => partial.readBytes ? await partial.readBytes() : enc.encode(partial.text ?? ""),
    readText: async () => partial.text ?? "",
    readSibling: partial.readSibling,
    // 可选回调全部透传（漏一条就会让"状态栏/头部按钮/底图开关"那条链断裂；
    // 这是上一轮 onInfo 测试失败的原因：makeCtx 根本没把 onInfo 放进 context）。
    onZoom: partial.onZoom,
    onPaging: partial.onPaging,
    onSection: partial.onSection,
    onInfo: partial.onInfo,
    onBasemap: partial.onBasemap,
  } as PreviewContext;
}

/** DXF 的"两行一对"结构。 */
function dxfPairs(lines: string[]): { code: number; value: string }[] {
  const out: { code: number; value: string }[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push({ code: Number(lines[i]), value: lines[i + 1] });
  return out;
}

beforeEach(() => {
  vi.resetModules();
});

describe("批次 4 路由", () => {
  it("媒体/3D/CAD/GIS 各归各的渲染器", async () => {
    const registry = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");
    const cases: [string, string][] = [
      ["a.mp3", "audio"],
      ["a.flac", "audio"],
      ["a.m4a", "audio"],
      ["a.mp4", "video"],
      ["a.mkv", "video"],
      ["a.m3u8", "video"],
      ["a.lrc", "lrc"],
      ["a.glb", "model3d"],
      ["a.gltf", "model3d"],
      ["a.stl", "model3d"],
      ["a.dxf", "cad"],
      ["a.dwg", "cad"],
      ["a.geojson", "gis"],
      ["a.topojson", "gis"],
      ["a.kml", "gis"],
      ["a.kmz", "gis"],
      ["a.gpx", "gis"],
      ["a.shp", "gis"],
    ];
    for (const [name, expected] of cases) {
      const ext = name.split(".").pop()!;
      const hit = await registry.resolvePreview({ root: "/r", rel: name, name, ext }, async () => enc.encode(""));
      expect(hit?.id, `${name} 应交给 ${expected}`).toBe(expected);
    }
  });

  it("真实 geojson 文本归 gis（曾被「gis 要求 zip 头」挡住）", async () => {
    const registry = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");
    const text = new TextEncoder().encode('{"type":"FeatureCollection","features":[]}');
    const hit = await registry.resolvePreview(
      { root: "/r", rel: "a.geojson", name: "a.geojson", ext: "geojson" },
      async () => text,
    );
    expect(hit?.id).toBe("gis");
  });

  it("kmz 与普通 zip 不串台（zip 仍归压缩包）", async () => {
    const registry = await import("../src/knowledge/preview/registry");
    await import("../src/knowledge/preview");
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const plain = await registry.resolvePreview({ root: "/r", rel: "a.zip", name: "a.zip", ext: "zip" }, async () => zip);
    expect(plain?.id).toBe("archive");
    const kmz = await registry.resolvePreview({ root: "/r", rel: "a.kmz", name: "a.kmz", ext: "kmz" }, async () => zip);
    expect(kmz?.id).toBe("gis");
  });
});

describe("LRC 解析", () => {
  it("时间标签、元信息与一行多标签", async () => {
    const { parseLrc } = await import("../src/knowledge/preview/plugins/media");
    const parsed = parseLrc(
      ["[ti:测试歌]", "[ar:歌手]", "[00:12.50]第一句", "[00:15.00][01:20.00]副歌"].join("\n"),
    );
    expect(parsed.meta).toEqual([
      { key: "ti", value: "测试歌" },
      { key: "ar", value: "歌手" },
    ]);
    // 一行两个时间标签 → 两个条目（同一句在每个时间点各出现一次，利于后续同步高亮）
    expect(parsed.lines.map((l) => l.text)).toEqual(["第一句", "副歌", "副歌"]);
    expect(parsed.lines.map((l) => l.time)).toEqual(["00:12.50", "00:15.00", "01:20.00"]);
  });

  it("没有时间标签时按纯文本兜底（不丢内容）", async () => {
    const { lrcPlugin } = await import("../src/knowledge/preview/plugins/media");
    const ctx = makeCtx({ ext: "lrc", text: "只是一句话" });
    await lrcPlugin.render(ctx);
    expect(ctx.container.textContent).toContain("按纯文本显示");
  });
});

describe("媒体：编码解不了要说实话", () => {
  it("音频渲染 <audio> 且挂 blob 地址", async () => {
    const { audioPlugin } = await import("../src/knowledge/preview/plugins/media");
    const ctx = makeCtx({ ext: "mp3", readBytes: async () => new Uint8Array([1, 2, 3]) });
    await audioPlugin.render(ctx);
    const el = ctx.container.querySelector("audio")!;
    expect(el).not.toBeNull();
    expect(el.src.startsWith("blob:")).toBe(true);
    expect(ctx.container.querySelector(".kb-media-meta")!.textContent).toContain("a.mp3");
  });

  it("视频给 <video>，出错时提示用默认应用打开", async () => {
    const { videoPlugin } = await import("../src/knowledge/preview/plugins/media");
    const ctx = makeCtx({ ext: "mkv", readBytes: async () => new Uint8Array([9, 9]) });
    await videoPlugin.render(ctx);
    const el = ctx.container.querySelector("video")!;
    el.dispatchEvent(new Event("error"));
    expect(ctx.container.querySelector(".kb-media-meta")!.textContent).toContain("默认应用打开");
  });
});

describe("DXF 自解析", () => {
  it("LINE/CIRCLE/ARC/LWPOLYLINE/TEXT 都出图元", async () => {
    const { parseDxfEntities } = await import("../src/knowledge/preview/plugins/cad");
    const pairs = dxfPairs(
      `0
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
LWPOLYLINE
70
1
10
0
20
0
10
10
20
0
10
10
20
10
0
CIRCLE
10
50
20
50
40
20
0
ARC
10
0
20
0
40
10
50
0
51
90
0
TEXT
10
5
20
5
40
2.5
1
房间A
0
ENDSEC
0
EOF`.split("\n"),
    );
    const { segments } = parseDxfEntities(pairs);
    expect(segments.filter((s) => s.kind === "path").length).toBe(4);
    const text = segments.find((s) => s.kind === "text")!;
    expect(text.text).toBe("房间A");
    expect(text.height).toBe(2.5);
  });

  it("INSERT 展开块定义（块先读、引用后展开）", async () => {
    const { parseDxfEntities } = await import("../src/knowledge/preview/plugins/cad");
    const pairs = dxfPairs(
      `0
SECTION
2
BLOCKS
0
BLOCK
2
DOOR
10
0
20
0
0
LINE
10
0
20
0
11
10
21
0
0
ENDBLK
0
ENDSEC
0
SECTION
2
ENTITIES
0
INSERT
2
DOOR
10
100
20
200
0
ENDSEC
0
EOF`.split("\n"),
    );
    const { segments, skipped } = parseDxfEntities(pairs);
    expect(skipped).toBe(0);
    expect(segments.find((s) => s.kind === "path")!.d).toBe("M 100 200 L 110 200");
  });

  it("没定义的块引用计入跳过数（不静默吞掉）", async () => {
    const { parseDxfEntities } = await import("../src/knowledge/preview/plugins/cad");
    const pairs = dxfPairs(
      `0
SECTION
2
ENTITIES
0
INSERT
2
NOPE
10
0
20
0
0
ENDSEC`.split("\n"),
    );
    const { segments, skipped } = parseDxfEntities(pairs);
    expect(segments.length).toBe(0);
    expect(skipped).toBe(1);
  });

  it("\\U+XXXX 转义与 %%c 符号解码（中文图纸常见）", async () => {
    const { decodeDxfText } = await import("../src/knowledge/preview/plugins/cad");
    expect(decodeDxfText("\\U+623F\\U+95F4A")).toBe("房间A");
    expect(decodeDxfText("Φ%%c12")).toBe("ΦØ12");
  });

  it("SVG 输出翻转 Y 轴并给出 viewBox", async () => {
    const { segmentsToSvg } = await import("../src/knowledge/preview/plugins/cad");
    const { svg, width, height } = segmentsToSvg([{ kind: "path", d: "M 0 0 L 100 50" }], 0);
    expect(width).toBeGreaterThan(100);
    expect(height).toBeGreaterThan(50);
    expect(svg).toContain("scale(1 -1)");
    expect(svg).toContain('<path d="M 0 0 L 100 50" />');
  });

  it("二进制 DXF → 明确说明，而不是空白", async () => {
    const { cadPlugin } = await import("../src/knowledge/preview/plugins/cad");
    const binary = enc.encode("AutoCAD Binary DXF\r\n\u001a\u0000");
    const ctx = makeCtx({ ext: "dxf", readBytes: async () => binary });
    await cadPlugin.render(ctx);
    expect(ctx.container.textContent).toContain("二进制 DXF");
  });
});

describe("3D：不做的东西给诚实卡片", () => {
  it("FBX/USDZ 这类没有解码器的格式不出空白画布", async () => {
    const { model3dPlugin } = await import("../src/knowledge/preview/plugins/model3d");
    const ctx = makeCtx({ ext: "usdz", readBytes: async () => new Uint8Array([0x50, 0x4b]) });
    await model3dPlugin.render(ctx);
    expect(ctx.container.textContent).toContain("默认应用打开");
  });
});

describe("GIS：底图默认关闭", () => {
  it("GeoJSON 画要素，且**不**加载任何瓦片", async () => {
    const { gisPlugin } = await import("../src/knowledge/preview/plugins/gis");
    const text = JSON.stringify({
      type: "FeatureCollection",
      features: [
        { type: "Feature", properties: { name: "点一" }, geometry: { type: "Point", coordinates: [116.4, 39.9] } },
      ],
    });
    const infoTexts: string[] = [];
    const ctx = makeCtx({ ext: "geojson", text, onInfo: (t) => infoTexts.push(t ?? "") });
    // jsdom 里 Leaflet 创建地图可能抛（缺 DOM API）—— 那是环境限制，不是功能失败。
    try { await gisPlugin.render(ctx); } catch { /* 环境限制 */ }
    // GIS 信息现在浮在地图容器内（右上角），不再走 onInfo（那是状态栏通道，会重复显示）
    const corner = ctx.container.querySelector(".kb-gis-info-corner");
    expect(corner, "右上角应有要素数角标").not.toBeNull();
    expect(corner!.textContent, "角标应显示要素数").toContain("个要素");
    // 默认状态下没有任何 <img>（瓦片就是 img）——离线约束的可执行检查
    expect(ctx.container.querySelectorAll("img").length).toBe(0);
  });
});

describe("解不了的媒体：用系统预览图兜底（Quick Look）", () => {
  it("视频报错 → 取系统预览图贴在海报位，并说明来源", async () => {
    const { videoPlugin } = await import("../src/knowledge/preview/plugins/media");
    const ctx = makeCtx({ ext: "mkv", readBytes: async () => new Uint8Array([9, 9]) });
    // jsdom 没有 URL.createObjectURL（真实引擎都有）—— 与 SVG MIME 那两条同款打桩
    const original = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => original(blob));
    // 宿主提供"系统预览图"（真机上由 Rust 的 kb_thumbnail 出图）
    const poster = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    let asked = 0;
    (ctx as { systemThumbnail?: () => Promise<Uint8Array | null> }).systemThumbnail = async () => {
      asked += 1;
      return poster;
    };
    await videoPlugin.render(ctx);
    ctx.container.querySelector("video")!.dispatchEvent(new Event("error"));
    await waitForDom(() => {
      expect(ctx.container.querySelector(".kb-media-poster"), "应贴出系统预览帧").not.toBeNull();
    });
    expect(asked).toBe(1);
    expect(ctx.container.querySelector(".kb-media-meta")!.textContent).toContain("系统生成的预览帧");
    expect(ctx.container.querySelector(".kb-media-meta")!.textContent).toContain("WebView 解不了");
  });

  it("宿主拿不到预览图 → 只给文案（不假装有图）", async () => {
    const { videoPlugin } = await import("../src/knowledge/preview/plugins/media");
    const ctx = makeCtx({ ext: "wmv", readBytes: async () => new Uint8Array([1]) });
    (ctx as { systemThumbnail?: () => Promise<Uint8Array | null> }).systemThumbnail = async () => null;
    await videoPlugin.render(ctx);
    ctx.container.querySelector("video")!.dispatchEvent(new Event("error"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ctx.container.querySelector(".kb-media-poster")).toBeNull();
    expect(ctx.container.querySelector(".kb-media-meta")!.textContent).toContain("默认应用打开");
  });
});
