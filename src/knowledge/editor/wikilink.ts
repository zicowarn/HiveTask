/**
 * [[wikilink]] 的编辑器侧能力（设计篇 v3）：
 * - `wikilinkCompletion()`：敲 `[[` 后补全笔记名（数据源 = knowledge store
 *   的文件清单缓存 `loadFileIndex`，懒加载一次后驻留；源码/live 两种模式都装）；
 * - `wikilinkPreview()`：live preview 装饰（accent 点状下划线 + 手型）+
 *   **Cmd/Ctrl+点击跳转**（与 VS Code 链接同款习惯，不与光标编辑抢普通点击；
 *   消解失败 toast 提示）。源码模式不装（richCompartment 随 livePreview 卸载）。
 *
 * 消解语义与 Rust `kb_graph.rs::resolve_target` 一致（tests/wikilink.test.ts
 * 两侧同用例锚定）。root/rel 复用 image.ts 的 docContext facet。
 */
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { readDocContext } from "./image";
import { useKnowledgeStore } from "../../stores/knowledge";
import { pushToast } from "../../toast";
import { t } from "../../i18n";
import { buildNoteIndex, noteCandidates, resolveWikilink, wikilinkTargetOf } from "../wikilink";

// ---- 补全 ----

async function wikilinkSource(context: CompletionContext): Promise<CompletionResult | null> {
  const before = context.matchBefore(/\[\[[^\[\]\n]*$/);
  if (!before) return null;
  const typed = before.text;
  const query = typed.slice(2);
  const knowledge = useKnowledgeStore();
  const rels = await knowledge.loadFileIndex().catch(() => [] as string[]);
  const options = noteCandidates(buildNoteIndex(rels))
    .filter((c) => c.label.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 50)
    .map((c) => ({ label: c.label, detail: c.detail || undefined, apply: `${c.label}]]`, type: "text" }));
  if (options.length === 0) return null;
  return {
    from: before.from + (typed.length - query.length),
    options,
    validFor: /^[^\[\]\n]*$/,
  };
}

export function wikilinkCompletion(): Extension {
  return autocompletion({ override: [wikilinkSource], activateOnTyping: true, icons: false });
}

// ---- live preview 装饰 + Cmd/Ctrl+点击 ----

const WIKILINK_RE = /\[\[[^\[\]\n]+\]\]/g;

/** 行内代码段区间（成对反引号之间）——装饰与 Rust 索引同一忽略口径。 */
function inlineCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = -1;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "`") {
      let j = i;
      while (j < text.length && text[j] === "`") j++;
      if (start < 0) start = i;
      else {
        ranges.push([start, j]);
        start = -1;
      }
      i = j;
      continue;
    }
    i++;
  }
  return ranges;
}

function inInlineCode(pos: number, end: number, codeRanges: Array<[number, number]>): boolean {
  return codeRanges.some(([s, e]) => pos < e && end > s);
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    let inFence = false;
    let pos = doc.lineAt(from).from;
    while (pos < to) {
      const line = doc.lineAt(pos);
      const trimmed = line.text.trimStart();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        inFence = !inFence;
      } else if (!inFence) {
        const codeRanges = inlineCodeRanges(line.text);
        WIKILINK_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = WIKILINK_RE.exec(line.text)) !== null) {
          const from = line.from + m.index;
          const to = from + m[0].length;
          if (inInlineCode(from, to, codeRanges)) continue;
          const target = wikilinkTargetOf(m[0].slice(2, -2));
          builder.add(
            from,
            to,
            Decoration.mark({ class: "cm-wikilink", ...(target ? { attributes: { "data-wikilink": target } } : {}) }),
          );
        }
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const wikilinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export function wikilinkPreview(): Extension {
  return [
    wikilinkPlugin,
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (!(event.metaKey || event.ctrlKey)) return false;
        const el = (event.target as HTMLElement | null)?.closest(".cm-wikilink");
        const raw = el?.getAttribute("data-wikilink");
        if (!raw) return false;
        const ctx = readDocContext(view.state);
        void (async () => {
          const knowledge = useKnowledgeStore();
          const rels = await knowledge.loadFileIndex().catch(() => [] as string[]);
          const rel = resolveWikilink(raw, ctx?.rel ?? null, buildNoteIndex(rels));
          if (rel) {
            knowledge.openFile(rel);
          } else {
            pushToast({ kind: "error", message: t("kb.wikilinkMissing", { name: raw }) });
          }
        })();
        event.preventDefault();
        return true;
      },
    }),
    EditorView.theme({
      ".cm-wikilink": {
        color: "var(--accent)",
        "text-decoration": "underline",
        "text-decoration-style": "dotted",
        "text-underline-offset": "2px",
        cursor: "pointer",
      },
    }),
  ];
}
