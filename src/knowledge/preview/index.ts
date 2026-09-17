/**
 * 预览格式注册（唯一的"格式 → 渲染器"清单）。
 *
 * 每个条目只在**打开该类文件时**才动态加载它的实现模块（体积按需付）。
 * 新增格式：写一个 `plugins/xxx.ts`，在这里 `registerPreview` 一行，完成。
 */
import { registerPreview } from "./registry";
import { TEXT_EXTENSIONS } from "./plugins/text";
import { ARCHIVE_EXTENSIONS, ARCHIVE_GZ_EXTENSIONS } from "./plugins/archive";
import { SHEET_EXTENSIONS, SLIDES_EXTENSIONS, WORD_EXTENSIONS } from "./plugins/office";
import { OFD_EXTENSIONS } from "./plugins/ofd";
import {
  DRAWIO_EXTENSIONS,
  EPUB_EXTENSIONS,
  XMIND_EXTENSIONS,
  XPS_EXTENSIONS,
} from "./plugins/ebook";
import { AUDIO_EXTENSIONS, LRC_EXTENSIONS, VIDEO_EXTENSIONS } from "./plugins/media";
import { ODF_SLIDES_EXTENSIONS, ODF_TEXT_EXTENSIONS } from "./plugins/odf";
import { MODEL_EXTENSIONS } from "./plugins/model3d";
import { CAD_EXTENSIONS } from "./plugins/cad";
import { GIS_EXTENSIONS } from "./plugins/gis";

// ---- 批次 1：文本/代码、PDF、压缩包、邮件 ----
registerPreview({
  load: () => import("./plugins/text").then((m) => m.textPlugin),
  // 扩展名清单由插件自身导出（与它支持的语言表同源，不重复维护）
  describe: { id: "text", extensions: TEXT_EXTENSIONS, head: [] },
});
registerPreview({
  load: () => import("./plugins/pdf").then((m) => m.pdfPlugin),
  describe: { id: "pdf", extensions: ["pdf"], head: ["%PDF"] },
});
registerPreview({
  load: () => import("./plugins/archive").then((m) => m.archivePlugin),
  // gz/tgz 由同一个插件处理（gzip 解出后若是 tar 再列条目）—— 声明与实现保持一致
  describe: { id: "archive", extensions: [...ARCHIVE_EXTENSIONS, ...ARCHIVE_GZ_EXTENSIONS], head: ["PK.."] },
});
registerPreview({
  load: () => import("./plugins/email").then((m) => m.emailPlugin),
  describe: { id: "email", extensions: ["eml", "mime"], head: [] },
});

// ---- 批次 2：Office ----
registerPreview({
  load: () => import("./plugins/office").then((m) => m.wordPlugin),
  describe: { id: "word", extensions: WORD_EXTENSIONS, head: ["PK..(word/)"] },
});
registerPreview({
  load: () => import("./plugins/office").then((m) => m.sheetPlugin),
  describe: { id: "sheet", extensions: SHEET_EXTENSIONS, head: ["PK..(xl/)"] },
});
registerPreview({
  load: () => import("./plugins/office").then((m) => m.slidesPlugin),
  describe: { id: "slides", extensions: SLIDES_EXTENSIONS, head: ["PK..(ppt/)"] },
});

// ---- 批次 3：OFD（国标版式文档）、电子书与矢量文档 ----
registerPreview({
  load: () => import("./plugins/ofd").then((m) => m.ofdPlugin),
  describe: { id: "ofd", extensions: OFD_EXTENSIONS, head: ["PK..(OFD.xml)"] },
});
registerPreview({
  load: () => import("./plugins/ebook").then((m) => m.epubPlugin),
  describe: { id: "epub", extensions: EPUB_EXTENSIONS, head: ["PK..(META-INF/container.xml)"] },
});
registerPreview({
  load: () => import("./plugins/ebook").then((m) => m.xpsPlugin),
  describe: { id: "xps", extensions: XPS_EXTENSIONS, head: ["PK..(Documents/)"] },
});
registerPreview({
  load: () => import("./plugins/ebook").then((m) => m.xmindPlugin),
  describe: { id: "xmind", extensions: XMIND_EXTENSIONS, head: ["PK..(content.json)"] },
});
registerPreview({
  load: () => import("./plugins/ebook").then((m) => m.drawioPlugin),
  describe: { id: "drawio", extensions: DRAWIO_EXTENSIONS, head: [] },
});

// ---- 批次 4：媒体 / 3D / CAD / GIS ----
registerPreview({
  load: () => import("./plugins/media").then((m) => m.audioPlugin),
  describe: { id: "audio", extensions: AUDIO_EXTENSIONS, head: [] },
});
registerPreview({
  load: () => import("./plugins/media").then((m) => m.videoPlugin),
  describe: { id: "video", extensions: VIDEO_EXTENSIONS, head: [] },
});
registerPreview({
  load: () => import("./plugins/media").then((m) => m.lrcPlugin),
  describe: { id: "lrc", extensions: LRC_EXTENSIONS, head: [] },
});
registerPreview({
  load: () => import("./plugins/model3d").then((m) => m.model3dPlugin),
  describe: { id: "model3d", extensions: MODEL_EXTENSIONS, head: ["glTF"] },
});
registerPreview({
  load: () => import("./plugins/cad").then((m) => m.cadPlugin),
  describe: { id: "cad", extensions: CAD_EXTENSIONS, head: ["AC10"] },
});
registerPreview({
  load: () => import("./plugins/gis").then((m) => m.gisPlugin),
  describe: { id: "gis", extensions: GIS_EXTENSIONS, head: ["PK..(kmz)"] },
});

// ---- 批次 5：ODF 文档（odt/ott/odp/otp）——与 OOXML 结构不同，自研解析 ----
registerPreview({
  load: () => import("./plugins/odf").then((m) => m.odfTextPlugin),
  describe: { id: "odfText", extensions: ODF_TEXT_EXTENSIONS, head: ["PK..(content.xml)"] },
});
registerPreview({
  load: () => import("./plugins/odf").then((m) => m.odfSlidesPlugin),
  describe: { id: "odfSlides", extensions: ODF_SLIDES_EXTENSIONS, head: ["PK..(content.xml)"] },
});

export * from "./registry";
export * from "./zoom";
