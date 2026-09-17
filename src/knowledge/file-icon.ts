/**
 * 文件图标：**按类别**给 Octicon（不引第三方图标字体）。
 *
 * 为什么不用 MarkText 那套（`@marktext/file-icons`，MIT、632KB、按扩展名给彩色图标）：
 * ① 本项目的图标铁律是"一律走 EditorIcon 的 Octicon 族"（AGENTS.md），引彩色图标字体是另一套体系；
 * ② 类别级区分（代码/文档/媒体/压缩/二进制）已够"一眼扫过去"；
 * ③ 零新依赖。若将来确要 per-language 彩色图标，`@marktext/file-icons` 是最省事的借用对象
 *（它 `fileIconClass.ts` 里有一条踩坑记录同样适用于我们：**按扩展名匹配要优先于整名匹配**，
 *  否则 `Dockerfile-Notes.md` 会被当成 Dockerfile 图标）。
 */
import type { KbEntry } from "../api";

const CODE = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte", "rs", "py", "rb", "go", "java", "kt", "kts",
  "c", "h", "cc", "cpp", "hpp", "cs", "php", "swift", "scala", "sh", "zsh", "bash", "fish", "ps1",
  "sql", "graphql", "gql", "html", "htm", "css", "scss", "sass", "less", "lua", "r", "pl", "ex", "exs",
  "json", "jsonc", "json5", "yml", "yaml", "toml", "ini", "conf", "env", "xml", "lock",
]);
const MARKUP = new Set(["md", "markdown", "mdx"]);
const MEDIA = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "heic", "tiff", "tif", "psd",
  "mp3", "wav", "ogg", "flac", "m4a", "aac", "aiff", "mp4", "mov", "webm", "mkv", "avi",
]);
const ARCHIVE = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war"]);
const BINARY = new Set(["exe", "dll", "so", "dylib", "bin", "wasm", "class", "o", "a", "dmg", "iso", "pkg", "deb", "rpm"]);
const DATA = new Set(["csv", "tsv", "xls", "xlsx", "parquet", "db", "sqlite", "sqlite3", "pdf", "doc", "docx", "ppt", "pptx"]);

/** 取扩展名（小写、不含点）；无扩展名返回 ""。 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  // 前导点的隐藏文件（`.gitignore`）不算扩展名
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** 条目 → Octicon 名（EditorIcon 的 `o.*` 族）。 */
/** 只给文件名时取图标（⌘P 的结果行用）。 */
export function iconForFile(name: string): string {
  return iconForEntry({ name, kind: "file" });
}

export function iconForEntry(entry: Pick<KbEntry, "name" | "kind">, open = false): string {
  if (entry.kind === "symlink") return "o.file-symlink-file";
  if (entry.kind === "dir") return open ? "o.file-directory-open-fill" : "o.file-directory-fill";
  const ext = extensionOf(entry.name);
  if (MARKUP.has(ext)) return "o.markdown";
  if (CODE.has(ext)) return "o.file-code";
  if (MEDIA.has(ext)) return "o.file-media";
  if (ARCHIVE.has(ext)) return "o.file-zip";
  if (BINARY.has(ext)) return "o.file-binary";
  if (DATA.has(ext)) return "o.layout-table"; // 表格/数据类复用表格图标
  return "o.file";
}
