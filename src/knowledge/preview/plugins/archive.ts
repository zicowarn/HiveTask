/**
 * 压缩包预览：列出条目（名称 / 大小 / 压缩后大小 / 修改时间），可展开查看**文本条目**内容。
 *
 * 与 OFV 的 archive 插件同思路（先列目录、再按需解出单个条目），差别在于我们不自动解压全部条目
 * （大压缩包会吃内存），只在用户点开某一项时解那一项。
 */
import type { PreviewContext, PreviewInstance, PreviewTool } from "../registry";
import { withFind } from "../dom-find";

export const ARCHIVE_EXTENSIONS = ["zip", "jar", "war", "apk"];
/** .tar.gz/.tgz 这类我们只认 gzip 头，内部 tar 结构本期不解析（记为待做）。 */
export const ARCHIVE_GZ_EXTENSIONS = ["gz", "tgz"];

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const TEXT_IN_ARCHIVE = /\.(txt|md|markdown|json|ya?ml|toml|ini|csv|tsv|log|html?|css|scss|js|jsx|ts|tsx|vue|py|rs|go|java|kt|c|h|cpp|hpp|sh|zsh|bash|sql|xml|svg|env|gitignore|editorconfig)$/i;

export const archivePlugin = {
  tools: ["find"] satisfies PreviewTool[],
  id: "archive",
  extensions: ARCHIVE_EXTENSIONS,
  /** zip 的 magic：PK\x03\x04（空压缩包是 PK\x05\x06）。 */
  matchHead: (head: Uint8Array) => head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05),
  async render(ctx: PreviewContext): Promise<PreviewInstance> {
    const JSZip = (await import("jszip")).default;
    const bytes = await ctx.readBytes();
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
