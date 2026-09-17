/**
 * 压缩包预览：列出条目（名称 / 大小 / 压缩后大小 / 修改时间），可展开查看**文本条目**内容。
 *
 * 与 OFV 的 archive 插件同思路（先列目录、再按需解出单个条目），差别在于我们不自动解压全部条目
 * （大压缩包会吃内存），只在用户点开某一项时解那一项。
 */
import type { PreviewContext, PreviewInstance, PreviewTool } from "../registry";
import { withFind } from "../dom-find";

export const ARCHIVE_EXTENSIONS = ["zip", "jar", "war", "apk"];
/** gzip 系（`.gz` 单文件、`.tar.gz`/`.tgz` 打包）。 */
export const ARCHIVE_GZ_EXTENSIONS = ["gz", "tgz"];

/** tar 的 512 字节块：头部 + 内容（按 512 对齐）直到两个全零块。 */
interface TarEntry {
  name: string;
  size: number;
  mtime: number;
}

/** 解析 tar（USTAR/PAX 都不挑：只读文件名、大小、时间三个字段）。 */
export function parseTar(buffer: Uint8Array): TarEntry[] {
  const decoder = new TextDecoder();
  const entries: TarEntry[] = [];
  let offset = 0;
  const readString = (start: number, length: number): string => {
    const slice = buffer.subarray(start, start + length);
    const end = slice.indexOf(0);
    return decoder.decode(end >= 0 ? slice.subarray(0, end) : slice).trim();
  };
  while (offset + 512 <= buffer.length) {
    const name = readString(offset, 100);
    if (!name) break; // 全零块 = 结束
    const octal = (start: number, length: number): number => {
      const raw = readString(start, length).replace(/\0/g, "").trim();
      const value = Number.parseInt(raw || "0", 8);
      return Number.isFinite(value) ? value : 0;
    };
    const size = octal(offset + 124, 12);
    const mtime = octal(offset + 136, 12) * 1000;
    entries.push({ name, size, mtime });
    // 内容按 512 对齐；PAX 头的扩展属性跳过但条目本身不算内容
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const TEXT_IN_ARCHIVE = /\.(txt|md|markdown|json|ya?ml|toml|ini|csv|tsv|log|html?|css|scss|js|jsx|ts|tsx|vue|py|rs|go|java|kt|c|h|cpp|hpp|sh|zsh|bash|sql|xml|svg|env|gitignore|editorconfig)$/i;

/** gzip 系：解压后判断是不是 tar 包，分别给"条目列表"或"文本内容"。 */
async function renderGzip(ctx: PreviewContext, bytes: Uint8Array): Promise<PreviewInstance> {
  const { ungzip } = await import("pako");
  let inner: Uint8Array;
  try {
    inner = ungzip(bytes);
  } catch (error) {
    throw new Error(`gzip 解压失败（文件可能损坏）：${String(error)}`);
  }

  const wrap = document.createElement("div");
  wrap.className = "kb-archive";
  const note = document.createElement("p");
  note.className = "kb-note";
  const entries = parseTar(inner);
  if (entries.length > 0) {
    note.textContent = `gzip 内的 tar 包 · 共 ${entries.length} 个条目 · 解压后 ${humanSize(inner.length)}`;
    wrap.appendChild(note);
    const list = document.createElement("div");
    list.className = "kb-archive-list";
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "kb-archive-row";
      const name = document.createElement("span");
      name.className = "kb-archive-name";
      name.textContent = entry.name;
      const size = document.createElement("span");
      size.className = "kb-archive-size";
      size.textContent = entry.size ? humanSize(entry.size) : "—";
      const time = document.createElement("span");
      time.className = "kb-archive-time";
      time.textContent = entry.mtime ? new Date(entry.mtime).toLocaleString() : "";
      row.append(name, size, time);
      list.appendChild(row);
    }
    wrap.appendChild(list);
    ctx.container.replaceChildren(wrap);
    return withFind(ctx);
  }

  // 单个文件（.gz 最常见）：能当文本读就当文本，否则只报大小
  note.textContent = `gzip 压缩的单个文件 · 解压后 ${humanSize(inner.length)}`;
  wrap.appendChild(note);
  const asText = new TextDecoder("utf-8", { fatal: false }).decode(inner);
  const binary = inner.subarray(0, 4096).some((byte) => byte === 0) || asText.includes("\uFFFD");
  const pre = document.createElement("pre");
  pre.className = "kb-archive-preview";
  pre.textContent = binary ? "（二进制内容，解压后无法按文本显示）" : asText;
  wrap.appendChild(pre);
  ctx.container.replaceChildren(wrap);
  return withFind(ctx);
}

export const archivePlugin = {
  tools: ["find"] satisfies PreviewTool[],
  id: "archive",
  extensions: [...ARCHIVE_EXTENSIONS, ...ARCHIVE_GZ_EXTENSIONS],
  /** zip 的 magic：PK\x03\x04（空压缩包是 PK\x05\x06）；gzip 是 1F 8B。 */
  matchHead: (head: Uint8Array) => {
    const zip = head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05);
    const gzip = head[0] === 0x1f && head[1] === 0x8b;
    return zip || gzip;
  },
  async render(ctx: PreviewContext): Promise<PreviewInstance> {
    const bytes = await ctx.readBytes();
    // gzip：先解压（pako 已经是依赖），解出来若是 tar 就列条目，否则按单个文本文件展示
    if (ctx.ext === "gz" || ctx.ext === "tgz") {
      return renderGzip(ctx, bytes);
    }
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(bytes);

    const wrap = document.createElement("div");
    wrap.className = "kb-archive";
    const list = document.createElement("div");
    list.className = "kb-archive-list";
    wrap.appendChild(list);

    // 改名的 Office 文件：按 zip 内部结构分派给对应渲染器（docx/xlsx/pptx 本都是 zip）
    const names = Object.keys(zip.files);
    const looksLike = (prefix: string) => names.some((name) => name.startsWith(prefix));
    if (looksLike("word/")) return (await import("./office")).wordPlugin.render(ctx);
    if (looksLike("xl/")) return (await import("./office")).sheetPlugin.render(ctx);
    if (looksLike("ppt/")) return (await import("./office")).slidesPlugin.render(ctx);

    const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));
    const meta = (file: { date: Date; _data?: { uncompressedSize?: number } }) =>
      file.date instanceof Date ? file.date.toLocaleString() : "";

    for (const file of entries) {
      const row = document.createElement("div");
      row.className = "kb-archive-row";
      if (file.dir) row.classList.add("dir");

      const name = document.createElement("span");
      name.className = "kb-archive-name";
      name.textContent = file.name;
      const size = document.createElement("span");
      size.className = "kb-archive-size";
      const uncompressed = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
      size.textContent = file.dir ? "" : typeof uncompressed === "number" ? humanSize(uncompressed) : "";
      const time = document.createElement("span");
      time.className = "kb-archive-time";
      time.textContent = meta(file as never);
      row.append(name, size, time);
      list.appendChild(row);

      if (file.dir || !TEXT_IN_ARCHIVE.test(file.name)) continue;
      // 文本条目：点开才解（不预解压，避免大包吃内存）
      row.classList.add("openable");
      const preview = document.createElement("pre");
      preview.className = "kb-archive-preview";
      preview.hidden = true;
      row.addEventListener("click", () => {
        void (async () => {
          if (!preview.hidden) {
            preview.hidden = true;
            return;
          }
          if (!preview.textContent) {
            preview.textContent = await file.async("string");
          }
          preview.hidden = false;
        })();
      });
      list.appendChild(preview);
    }

    ctx.container.replaceChildren(wrap);
    return withFind(ctx);
  },
};
