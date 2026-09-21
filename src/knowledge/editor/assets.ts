/**
 * 粘贴/拖放插图：把剪贴板或拖入的图片写进知识库，并插入 Markdown 引用。
 *
 * 落点规则（与 Typora 同思路，但更保守）：
 * - 存到**文档同级的 `assets/` 目录**（`docs/note.md` → `docs/assets/pasted-….png`），
 *   这样引用就是 `assets/x.png`，**不依赖文档在库中的深度**，也避免 `../` 满天飞；
 * - 文件名 `pasted-YYYYMMDD-HHMMSS.<ext>`，冲突时加序号；
 * - 写入走 `kb_write_bytes`（Rust 侧：根沙箱 + 自动建父目录 + 原子写）。
 *
 * 纯函数（命名/相对链接/文件筛选）与副作用（写盘 + 插入）分开，前者可单测。
 */
import { api, isTauri } from "../../api";

/** 文档同级 assets 目录下的相对路径。 */
export function assetRelPath(docRel: string, name: string): string {
  const dir = docRel.includes("/") ? docRel.slice(0, docRel.lastIndexOf("/")) : "";
  return dir ? `${dir}/assets/${name}` : `assets/${name}`;
}

/** 插入到文档里的引用（相对文档，故直接是 `assets/x.png`）。 */
export function assetLink(name: string, alt = name): string {
  return `![${alt}](assets/${name})`;
}

/** 时间戳文件名：`pasted-20260917-104500.png`。 */
export function pastedFileName(now: Date, index: number, ext: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `pasted-${stamp}${index > 0 ? `-${index}` : ""}.${ext}`;
}

/** 从 DataTransfer 里挑出图片文件（粘贴板与拖放共用）。 */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"));
}

/** 扩展名：优先用 MIME 推断（剪贴板里的 File 名常为 "image.png" 或空）。 */
export function extensionFor(file: File): string {
  const byType: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/avif": "avif",
  };
  const fromName = file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "";
  return byType[file.type] ?? fromName ?? "png";
}

/** 分块 base64（参数过长会栈溢出）。图片编辑的保存链路复用同一编码。 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000; // 分块避免参数过多
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 编辑另存的文件名：`edited-YYYYMMDD-HHMMSS.png`（冲突加序号）。一律 PNG：编辑输出不回写非 PNG 容器。 */
export function editedFileName(now: Date, index: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `edited-${stamp}${index > 0 ? `-${index}` : ""}.png`;
}

/** 编辑另存的落点：与原图同目录（原图通常已在 assets/ 里，不另开 assets 层）。 */
export function editedRelPath(origRel: string, name: string): string {
  const dir = origRel.includes("/") ? origRel.slice(0, origRel.lastIndexOf("/")) : "";
  return dir ? `${dir}/${name}` : name;
}

/** 空白画布保存的文件名：`drawn-YYYYMMDD-HHMMSS.png`（与"编辑已有图"的 edited- 区分来源）。 */
export function drawnFileName(now: Date, index: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `drawn-${stamp}${index > 0 ? `-${index}` : ""}.png`;
}

/** 空白画布的落点：当前文档同级的 assets/（与粘贴插图同一落点规则，引用不依赖文档深度）。 */
export function drawnRelPath(docRel: string, name: string): string {
  return assetRelPath(docRel, name);
}

export interface SavedImage {
  /** 库内相对路径（写盘用）。 */
  rel: string;
  /** 插入文档的 Markdown 片段。 */
  markdown: string;
  name: string;
}

/**
 * 保存一张图片并返回结果（不负责插入——插入由调用方决定位置）。
 * 冲突处理：同名已存在时依次尝试 `-1`、`-2`…
 */
export async function saveImageFile(
  root: string,
  docRel: string,
  file: File,
  now = new Date(),
): Promise<SavedImage> {
  const ext = extensionFor(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let index = 0;
  for (;;) {
    const name = pastedFileName(now, index, ext);
    const rel = assetRelPath(docRel, name);
    try {
      await api.kbWriteBytes(root, rel, toBase64(bytes));
      return { rel, markdown: assetLink(name), name };
    } catch (error) {
      // 仅"已存在"时换名重试；其它错误直接上抛（沙箱拒绝、磁盘满…）
      if (index < 20 && String(error).includes("已存在")) {
        index += 1;
        continue;
      }
      throw error;
    }
  }
}

/** 当前环境是否支持插图（浏览器预览没有 Rust 侧写入）。 */
export function canSaveImages(): boolean {
  return isTauri();
}
