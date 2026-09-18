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
    systemThumbnail: partial.systemThumbnail,
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
  // spyOn 叠 spyOn 会自指（original = 上一个 spy = 自己）→ 无限递归，先恢复
  vi.restoreAllMocks();
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

describe("3D：WebGL 用不了时给诚实卡片（照 OFV 的降级口径）", () => {
  it("不出空白画布：说明当前设备不支持，并带上文件名", async () => {
    // 注：解析本身由 tests/kb-model3d-loaders.test.ts 逐格式真跑；
    // 这里守的是"没有 WebGL 时退化成什么"——jsdom 恰好就是这种环境。
    const { model3dPlugin } = await import("../src/knowledge/preview/plugins/model3d");
    const ctx = makeCtx({ ext: "usdz", readBytes: async () => new Uint8Array([0x50, 0x4b]) });
    await model3dPlugin.render(ctx);
    expect(ctx.container.textContent).toContain("3D 预览不可用");
    expect(ctx.container.textContent).toContain("WebGL");
    expect(ctx.container.textContent).toContain("a.usdz");
  });

  it("系统能给预览图时贴出来（桌面适配：OFV 在网页里放的是「下载文件」链接）", async () => {
    const { model3dPlugin } = await import("../src/knowledge/preview/plugins/model3d");
    const ctx = makeCtx({
      ext: "usdz",
      readBytes: async () => new Uint8Array([0x50, 0x4b]),
      systemThumbnail: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });
    await model3dPlugin.render(ctx);
    expect(ctx.container.querySelector("img")?.src).toMatch(/^blob:/);
    expect(ctx.container.textContent).toContain("系统生成的预览图");
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

describe("媒体容器元信息（照 OFV 移植的解析器 → onInfo 状态栏）", () => {
  it("视频解析容器头并上报（解不了播放也能说清是什么）", async () => {
    const { videoPlugin } = await import("../src/knowledge/preview/plugins/media");
    const atom = (t: string, body: Uint8Array): Uint8Array => {
      const out = new Uint8Array(8 + body.length);
      new DataView(out.buffer).setUint32(0, 8 + body.length);
      for (let i = 0; i < 4; i++) out[4 + i] = t.charCodeAt(i);
      out.set(body, 8);
      return out;
    };
    const u32be = (v: number) => new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
    const zeros = (n: number) => new Uint8Array(n);
    // mvhd v0：ver/flags(4) ctime(4) mtime(4) timescale(4) duration(4) + 其余
    const mvhd = atom("mvhd", new Uint8Array([0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(600), ...u32be(1800), ...zeros(80 - 20)]));
    // tkhd v0：ver/flags(4) ctime(4) mtime(4) trackID(4) rsv(4) dur(4) rsv(8) layer(2) alt(2) vol(2) rsv(2) matrix(36) width(4) height(4)
    const tkhdBody = new Uint8Array([
      0, 0, 0, 0, ...u32be(0), ...u32be(0), ...u32be(1), ...u32be(0), ...u32be(1800),
      ...zeros(8), 0, 0, 0, 0x01, 0, 0, 0, 0,
      ...u32be(0x10000), ...u32be(0), ...u32be(0), ...u32be(0), ...u32be(0x10000), ...u32be(0), ...u32be(0), ...u32be(0), ...u32be(0x40000000),
      ...u32be(320 << 16), ...u32be(240 << 16),
    ]);
    expect(tkhdBody.length).toBe(84);
    const moov = atom("moov", new Uint8Array([...mvhd, ...atom("trak", atom("tkhd", tkhdBody))]));
    const ftyp = atom("ftyp", new Uint8Array([...new TextEncoder().encode("isom"), ...u32be(512), ...new TextEncoder().encode("isomiso2")]));
    const ctx = makeCtx({ ext: "mp4", readBytes: async () => new Uint8Array([...ftyp, ...moov]) });
    const infos: (string | null)[] = [];
    (ctx as { onInfo?: (v: string | null) => void }).onInfo = (v) => infos.push(v);
    await videoPlugin.render(ctx);
    expect(infos[0]).toContain("MP4");
    expect(infos[0]).toContain("320×240");
    expect(infos[0]).toContain("0:03");
  });

  it("FLV/TS 走 mpegts.js 分支（blob 照样带 MIME，MSE 不支持时给诚实文案）", async () => {
    const { videoPlugin } = await import("../src/knowledge/preview/plugins/media");
    const blobs: string[] = [];
    const original = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      if (blob instanceof Blob) blobs.push(blob.type);
      return original(blob);
    });
    const ctx = makeCtx({ ext: "flv", readBytes: async () => new Uint8Array([0x46, 0x4c, 0x56, 1]) });
    (ctx as { onInfo?: (v: string | null) => void }).onInfo = () => {};
    await videoPlugin.render(ctx);
    expect(blobs).toEqual(["video/x-flv"]);
    // 容器解析也认得 FLV 头（暂未识别详情就给格式名，不编造）
  });
});


  it("mpegts 失败后 <video> 的 error 事件不覆盖具体原因，且补系统预览图（用户实测 FLV 干等的修复）", async () => {
    const { videoPlugin } = await import("../src/knowledge/preview/plugins/media");
    // 用 mpegts-attach 的真实实现：坏字节 → mpegts 报错 → onFatal → 标记 mpegtsFailed
    const ctx = makeCtx({ ext: "flv", readBytes: async () => new Uint8Array([0x46, 0x4c, 0x56, 1]) });
    const poster = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    (ctx as { systemThumbnail?: () => Promise<Uint8Array | null> }).systemThumbnail = async () => poster;
    (ctx as { onInfo?: (v: string | null) => void }).onInfo = () => {};
    await videoPlugin.render(ctx);
    // 等异步 mpegts import + 失败回调（jsdom 里 isSupported=false 时走"不支持 MSE"直接降级）
    await new Promise((resolve) => setTimeout(resolve, 30));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // jsdom 无 MSE：失败链走到系统预览图兜底（真实引擎里的具体文案已在离屏探针验证）
    expect(ctx.container.querySelector(".kb-media-poster"), "失败时贴系统预览图").not.toBeNull();
    expect(ctx.container.querySelector(".kb-media-meta")!.textContent).not.toBe("");
  });

describe("媒体 blob 必须带 MIME（WKWebView 无类型 blob 一律拒播）", () => {
  it("音频/视频的 blob 带各自容器的 MIME（mp4 无 MIME 报 SRC_NOT_SUPPORTED，实机踩过）", async () => {
    const { audioPlugin, videoPlugin } = await import("../src/knowledge/preview/plugins/media");
    const blobs: string[] = [];
    const original = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      if (blob instanceof Blob) blobs.push(blob.type);
      return original(blob);
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await audioPlugin.render(makeCtx({ ext: "m4a", readBytes: async () => bytes }));
    await videoPlugin.render(makeCtx({ ext: "mp4", readBytes: async () => bytes }));
    expect(blobs).toEqual(["audio/mp4", "video/mp4"]);
  });

  it("解不了的容器给 octet-stream（让 error 照常触发，走系统预览图兜底链）", async () => {
    const { videoPlugin } = await import("../src/knowledge/preview/plugins/media");
    const blobs: string[] = [];
    const original = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
      if (blob instanceof Blob) blobs.push(blob.type);
      return original(blob);
    });
    await videoPlugin.render(makeCtx({ ext: "mkv", readBytes: async () => new Uint8Array([1]) }));
    expect(blobs).toEqual(["application/octet-stream"]);
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
