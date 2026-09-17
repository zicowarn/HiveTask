/**
 * 「这个文件交给谁渲染」—— 预览面板的**唯一判定点**。
 *
 * 三档优先级：Markdown → 图片 → 其余一律交给**预览注册表**。
 *
 * 这里曾经踩过一个把整个注册表都架空的坑：末尾写的是 `return "text"`，
 * 于是 PDF / Office / OFD / DXF / 3D 全部走进「当纯文本显示」的分支——
 * 注册表分支（`kind === "other"`）成了死代码，插件再多也一个都跑不到。
 * 现在把它抽成纯函数并上测试，就是为了不再让"兜底值"悄悄吃掉新功能。
 */
export type PreviewKind = "image" | "markdown" | "text" | "other";

/** 光栅图 + SVG（都用 `<img>` 渲染，不进注册表）。 */
export const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "jfif",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "ico",
  "cur",
  "apng",
]);

/** Markdown（有专门的编辑器+实时预览，不走只读预览）。 */
export const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);

/**
 * @param ext 小写扩展名（不含点）
 * @param hasTextFallback 注册表认领不了、但内容判定为文本时，由宿主降级为文本视图
 */
export function previewKind(ext: string, hasTextFallback = false): PreviewKind {
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  if (IMAGE_EXT.has(ext)) return "image";
  if (hasTextFallback) return "text";
  return "other";
}

/**
 * 「看起来是文本吗」——注册表没有插件认领时，用它决定给文本视图还是"暂不支持"卡片。
 *
 * 两条判据：
 * 1. **含 NUL** → 二进制（文本文件里不会有，二进制头几个字节基本都有）；
 * 2. **替换字符（U+FFFD）占比 ≥ 5%** → 二进制。被按文本解码的二进制通常远超这个比例
 *    （几十个百分点），而"偶发 1–3 处坏字节的正常文本"不该因此被判死 ——
 *    所以带一个**绝对条数下限**（4 个）再谈比例，短样本上的单点噪声不作数。
 */
const BINARY_REPLACEMENT_RATIO = 0.05;
const BINARY_REPLACEMENT_MIN = 4;

export function looksLikeText(sample: string): boolean {
  if (sample.includes("\u0000")) return false;
  if (!sample) return true;
  const replacements = (sample.match(/\uFFFD/g) ?? []).length;
  if (replacements < BINARY_REPLACEMENT_MIN) return true;
  return replacements / sample.length < BINARY_REPLACEMENT_RATIO;
}

/**
 * 状态栏「文件格式」一格的文案。
 *
 * 文本/代码返回空串：交给状态栏按扩展名映射语言名（`KB_LANGUAGES`）。
 * 其余格式必须由这里给准话 —— 以前没有这张表，状态栏对 PDF/docx/xlsx 一律显示
 * 「纯文本」（用户实测发现）。
 */
const FORMAT_LABEL_KEYS: Record<string, string> = {
  pdf: "kb.format.pdf",
  word: "kb.format.word",
  sheet: "kb.format.sheet",
  slides: "kb.format.slides",
  ofd: "kb.format.ofd",
  epub: "kb.format.epub",
  xps: "kb.format.xps",
  xmind: "kb.format.xmind",
  drawio: "kb.format.drawio",
  archive: "kb.format.archive",
  email: "kb.format.email",
  audio: "kb.format.audio",
  video: "kb.format.video",
  lrc: "kb.format.lyrics",
  model3d: "kb.format.model3d",
  cad: "kb.format.cad",
  gis: "kb.format.gis",
  svg: "kb.format.svg",
  image: "kb.format.image",
};

/**
 * @param ext 小写扩展名
 * @param kind 面板判定的渲染分支
 * @param pluginId 注册表解析出的插件 id（文本类为空）
 * @returns i18n key；空串 = 状态栏用语言映射表
 */
export function formatLabelKey(ext: string, kind: PreviewKind, pluginId?: string | null): string {
  if (kind === "markdown") return ""; // 状态栏已映射为 Markdown
  if (kind === "image") return FORMAT_LABEL_KEYS[ext === "svg" ? "svg" : "image"] ?? "";
  if (pluginId) return FORMAT_LABEL_KEYS[pluginId] ?? "";
  return "";
}

/** 文本降级的上限：比这更大的文件不来赌"是不是文本"（避免把上百 MB 二进制读成字符串）。 */
export const TEXT_FALLBACK_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 图片 MIME ——**必须按扩展名给对**：
 * `<img src="blob:...">` 的 blob 若没有类型，PNG/JPEG 还能靠内容嗅探，**SVG 不行**
 * （WebKit 会当成纯文本，表现为"打开 SVG 是一片空白"）。
 */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
  ico: "image/x-icon",
  cur: "image/x-icon",
  apng: "image/apng",
};

export function imageMimeFor(ext: string): string {
  return IMAGE_MIME[ext] ?? "application/octet-stream";
}
