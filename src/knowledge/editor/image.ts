/**
 * 图片 widget：`![alt](src)` 在光标不在该处时渲染成真 `<img>`。
 *
 * 三条路径（离线优先）：
 * - **本地相对路径** → 经 `kb_read_bytes` 从知识库根读出字节 → object URL（**不经过 webview 的文件访问**，
 *   与其余预览一致，也天然受根沙箱保护）；
 * - `http(s)://` → 直接交给浏览器（离线时显示 alt 与错误样式，不做占位欺骗）；
 * - `data:` → 原样使用。
 *
 * 文档上下文（根 + 当前文件相对路径）通过 CM6 facet 传入，而不是模块级全局变量——
 * facet 属于 state，测试与多实例都安全。
 */
import { Facet } from "@codemirror/state";
import type { EditorState, Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { fullSyntaxTree } from "./tree";
import type { SyntaxNodeRef } from "@lezer/common";
import { api, isTauri } from "../../api";
import { imageMimeFor } from "../preview/kind";

export interface DocContext {
  root: string;
  /** 当前文档相对根的路径（用于解析相对图片路径）。 */
  rel: string;
}

/** 当前文档上下文（未提供时只渲染远程与 data URL）。 */
export const docContext = Facet.define<DocContext | null, DocContext | null>({
  combine: (values) => values[0] ?? null,
});

/** 读取当前文档上下文（类型安全的唯一入口）。 */
export function readDocContext(state: EditorState): DocContext | null {
  return state.facet(docContext);
}

/** object URL 缓存：同一张图多次出现只读一次；编辑器卸载时统一释放。 */
const urlCache = new Map<string, string>();
let loadSeq = 0;

function isRemoteOrData(src: string): boolean {
  return /^(https?:|data:)/i.test(src);
}

/** 文档目录 + 相对引用 → 根内相对路径（`.` / `..` 在此归一化，仍受后端沙箱复核）。 */
export function resolveImageRel(docRel: string, src: string): string {
  const dir = docRel.includes("/") ? docRel.slice(0, docRel.lastIndexOf("/")) : "";
  const cleaned = src.replace(/^\.\//, "").split("?")[0].split("#")[0];
  const segments = `${dir ? `${dir}/` : ""}${cleaned}`.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

async function localImageUrl(ctx: DocContext, src: string): Promise<string> {
  const rel = resolveImageRel(ctx.rel, src);
  const key = `${ctx.root}::${rel}`;
  const cached = urlCache.get(key);
  if (cached) return cached;
  const bytes = await api.kbReadBytes(ctx.root, rel);
  // 必须带上 MIME：无类型的 blob 里 PNG/JPEG 还能靠内容嗅探，**SVG 会被当纯文本**
  // （正文里插入的矢量图会显示成空白）
  const ext = rel.includes(".") ? rel.split(".").pop()!.toLowerCase() : "";
  const url = URL.createObjectURL(new Blob([bytes], { type: imageMimeFor(ext) }));
  urlCache.set(key, url);
  return url;
}

/** 释放全部 object URL（编辑器卸载时调用）。 */
export function releaseImageCache(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly title: string,
  ) {
    super();
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM(view: EditorView): HTMLElement {
    const token = ++loadSeq;
    const wrap = document.createElement("span");
    wrap.className = "cm-kb-image";
    const img = document.createElement("img");
    img.alt = this.alt || this.src;
    if (this.title) img.title = this.title;
    img.loading = "lazy";
    const showError = () => {
      wrap.classList.add("cm-kb-image-error");
      wrap.textContent = this.alt ? `[图片加载失败：${this.alt}]` : `[图片加载失败：${this.src}]`;
    };
    img.addEventListener("error", showError);
    wrap.appendChild(img);

    const ctx = view.state.facet(docContext);
    if (isRemoteOrData(this.src) || !ctx || !isTauri()) {
      img.src = this.src;
    } else {
      void localImageUrl(ctx, this.src)
        .then((url) => {
          if (token > loadSeq) return; // 已被后续渲染取代
          img.src = url;
        })
        .catch(showError);
    }
    return wrap;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function cursorTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/** `Image` 节点 → 内联替换（图片不跨行，属行内装饰，可由 ViewPlugin 提供）。 */
export function imageItems(state: EditorState): { from: number; to: number; deco: Decoration }[] {
  const items: { from: number; to: number; deco: Decoration }[] = [];
  fullSyntaxTree(state).iterate({
    enter: (node: SyntaxNodeRef) => {
      if (node.name !== "Image") return;
      if (cursorTouches(state, node.from, node.to)) return;
      const source = state.doc.sliceString(node.from, node.to);
      const match = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/.exec(source.trim());
      if (!match) return;
      items.push({
        from: node.from,
        to: node.to,
        deco: Decoration.replace({ widget: new ImageWidget(match[2], match[1], match[3] ?? "") }),
      });
    },
  });
  return items;
}

export const imageTheme = EditorView.baseTheme({
  ".cm-kb-image": { display: "inline-block", verticalAlign: "top", maxWidth: "100%" },
  ".cm-kb-image img": { maxWidth: "100%", height: "auto", borderRadius: "4px", verticalAlign: "top" },
  ".cm-kb-image-error": {
    display: "inline-block",
    padding: "0 4px",
    border: "1px dashed var(--border)",
    borderRadius: "4px",
    color: "var(--text-dim)",
    fontSize: "var(--font-sm)",
  },
});

export function imageSupport(ctx: DocContext | null): Extension {
  return [docContext.of(ctx), imageTheme];
}
