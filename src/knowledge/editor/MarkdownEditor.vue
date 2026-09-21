<script setup lang="ts">
/**
 * 知识库的 Markdown 编辑器（T0 spike 的最小可用形态 → T6 继续加固）。
 *
 * 缓冲 = 磁盘上的 Markdown 源文本（**零失真**：不解析成中间模型，保存即写回）。
 * 视觉 = CM6 + live preview（记号随光标显隐）+ KaTeX/Mermaid 就地渲染。
 *
 * 中文相关的三件事在这里落地：① IME 组字期间冻结 decoration（ime-guard.ts）；
 * ② 字体栈显式带中文族；③ 编辑器不抢 IME 的 Enter/Esc（不自行处理按键序列）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorSelection, EditorState, Compartment } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { livePreview as livePreviewExtension } from "./live-preview";
import { mathAndDiagram } from "./math-diagram";
import { wikilinkCompletion, wikilinkPreview } from "./wikilink";
import { imageSupport, readDocContext, releaseImageCache } from "./image";
import { markdownKeymap, runCommand } from "./commands";
import { findTableSpan } from "./markdown-table";
import { openTableEditor } from "./table-editor-bus";
import {
  SearchCursor,
  SearchQuery,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { buildOutline, type OutlineItem } from "./outline";
import { useTheme } from "../../theme";
import { countText, type TextStats } from "./stats";
import { canSaveImages, imageFilesFrom, saveImageFile } from "./assets";
import type { MarkdownCommand } from "../../components/markdown-tools";
import { pushToast } from "../../toast";
import { t } from "../../i18n";

const props = withDefaults(
  defineProps<{
  /** 初始文本（切文件时由父组件换 key 或调 setText）。 */
  modelValue: string;
  readonly?: boolean;
  /** 知识库根与当前文件相对路径：用于解析 Markdown 里的相对图片引用。 */
  root?: string;
  rel?: string;
  /** 实时渲染（默认开）；关掉即"源代码模式"——只留语法着色，缓冲仍是同一份 Markdown。 */
  livePreview?: boolean;
  }>(),
  { readonly: false, livePreview: true },
);
const emit = defineEmits<{
  "update:modelValue": [value: string];
  /** 大纲：文档变化时给出标题列表（含行号），宿主的侧栏据此渲染并做光标跟随。 */
  outline: [items: OutlineItem[]];
  /** 字数/词数（状态栏显示；文档变化时上报）。 */
  stats: [value: TextStats];
  /** 右键：把菜单的锚点坐标交给宿主渲染（原生右键菜单会挡住我们自己的命令表）。 */
  contextmenu: [payload: { x: number; y: number }];
  /** ⌘F：宿主打开自绘查找条。 */
  find: [];
  /** 光标行列（1 基）——状态栏显示；失焦/卸载时传 null。 */
  cursor: [value: { line: number; col: number } | null];
  /** 工具条「画图」：请宿主打开空白画布（保存后由宿主在光标处插入引用）。 */
  draw: [];
}>();

/** 缩进宽度（空格数）：与状态栏显示同源，改这里就两边一起变。 */
const INDENT_WIDTH = 2;

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
const readOnlyCompartment = new Compartment();
/** 明暗主题：告诉 CM6（它的默认样式与其它 CM6 扩展都按这个 facet 走 &dark/&light）。 */
const darkThemeCompartment = new Compartment();
const docContextCompartment = new Compartment();
/** 实时渲染装饰（live-preview + 公式/图表）：源码模式下整体卸掉。 */
const richCompartment = new Compartment();

function docContext() {
  return props.root && props.rel ? { root: props.root, rel: props.rel } : null;
}

/** 实时渲染装饰组（源码模式为空）。 */
function richExtensions() {
  return props.livePreview ? [livePreviewExtension, mathAndDiagram(() => openTableAtCursor()), wikilinkPreview()] : [];
}

function extensions() {
  return [
    lineNumbers(),
    history(),
    darkThemeCompartment.of(EditorView.darkTheme.of(isDarkTheme())),
    // GFM：表格 / 待办 / 删除线 / 自动链接——与 GitHub 一致（`markdown()` 默认只开 CommonMark）
    markdown({ extensions: [GFM] }),
    // [[wikilink]] 补全（两种模式都装；数据源 = 文件清单缓存）
    wikilinkCompletion(),
    richCompartment.of(richExtensions()),
    // 查找：只取状态与匹配高亮；界面由我们自己的查找条渲染（CM6 默认面板是英文裸控件）
    search(),
    keymap.of([
      // ⌘F 交给宿主打开自绘查找条；F3/⇧F3 与 ⌘G/⇧⌘G 走我们自己的导航
      // （**不要**引入 searchKeymap：它的 findNext/findPrevious 在无有效查询时会打开 CM6 默认面板）
      { key: "Mod-f", run: () => { emit("find"); return true; } },
      { key: "F3", run: (view: EditorView) => stepMatch(view, false) },
      { key: "Shift-F3", run: (view: EditorView) => stepMatch(view, true) },
      { key: "Mod-g", run: (view: EditorView) => stepMatch(view, false) },
      { key: "Shift-Mod-g", run: (view: EditorView) => stepMatch(view, true) },
      // ⌥⌘T：表格网格编辑器（SoloMD 同款快捷键；光标在表内=编辑，不在=插入空表）
      { key: "Alt-Mod-t", run: () => { openTableAtCursor(); return true; } },
      ...markdownKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    indentUnit.of(" ".repeat(INDENT_WIDTH)),
    readOnlyCompartment.of(EditorState.readOnly.of(props.readonly === true)),
    imageSupport(docContext()),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        emit("update:modelValue", update.state.doc.toString());
        emit("outline", buildOutline(update.state));
        emit("stats", countText(update.state.doc.toString()));
      }
      if (update.selectionSet || update.docChanged || update.focusChanged) {
        emit("cursor", update.view.hasFocus ? cursorOf(update.state) : null);
      }
    }),
    EditorView.domEventHandlers({
      blur: () => {
        emit("cursor", null);
        return false;
      },
      focus: (_event, view) => {
        emit("cursor", cursorOf(view.state));
        return false;
      },
    }),
    EditorView.lineWrapping,
    EditorView.domEventHandlers({
      contextmenu: (event, view) => {
        event.preventDefault();
        const at = caretPoint(view, event.clientX, event.clientY);
        emit("contextmenu", at);
        return true;
      },
      // 粘贴/拖放插图：剪贴板或拖入的图片直接落盘到文档同级 assets/ 并插入引用
      paste: (event, view) => {
        const files = imageFilesFrom(event.clipboardData);
        if (files.length === 0) return false;
        event.preventDefault();
        void insertImages(view, files, view.state.selection.main.from);
        return true;
      },
      drop: (event, view) => {
        const files = imageFilesFrom(event.dataTransfer);
        if (files.length === 0) return false;
        event.preventDefault();
        const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from;
        void insertImages(view, files, at);
        return true;
      },
      // 键盘可达：Shift+F10 / 菜单键打开同一份命令菜单（Windows 惯例；也便于无人值守验证）
      keydown: (event, view) => {
        if (!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return false;
        event.preventDefault();
        emit("contextmenu", caretPoint(view));
        return true;
      },
    }),
  ];
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    state: EditorState.create({ doc: props.modelValue, extensions: extensions() }),
    parent: host.value,
  });
  emit("outline", buildOutline(view.state));
  emit("stats", countText(view.state.doc.toString()));
});

watch(
  () => props.modelValue,
  (next) => {
    // 只在外部（切文件 / 重新载入）与缓冲不同时替换，避免打断输入法组字
    if (!view || view.composing) return;
    const current = view.state.doc.toString();
    if (current === next) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: next } });
  },
);

watch(
  () => isDarkTheme(),
  (dark) => {
    view?.dispatch({ effects: darkThemeCompartment.reconfigure(EditorView.darkTheme.of(dark)) });
  },
);

watch(
  () => props.livePreview,
  (value) => {
    view?.dispatch({
      effects: richCompartment.reconfigure(
        value ? [livePreviewExtension, mathAndDiagram(() => openTableAtCursor()), wikilinkPreview()] : [],
      ),
    });
  },
);

watch(
  () => [props.root, props.rel],
  () => {
    view?.dispatch({ effects: docContextCompartment.reconfigure(imageSupport(docContext())) });
  },
);

watch(
  () => props.readonly,
  (value) => {
    view?.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(value === true)) });
  },
);

onBeforeUnmount(() => {
  emit("cursor", null);
  view?.destroy();
  view = null;
  releaseImageCache(); // 图片 object URL 统一释放
});

/** 收集全部命中（上限防御，超长文档不做无界扫描）。 */
function collectMatches(view: EditorView, query: SearchQuery, cap = 5000): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const cursor = new SearchCursor(view.state.doc, query.search, 0, view.state.doc.length);
  while (!cursor.next().done) {
    out.push({ from: cursor.value.from, to: cursor.value.to });
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * 跳到下一个/上一个命中（**自实现**，不用 CM6 的 findNext/findPrevious）。
 *
 * 原因：`searchCommand` 在"无有效查询"时会 `openSearchPanel(view)`——即弹出它自带的
 * 英文默认面板（用户实测到的"点下一个反而出现底部原始搜索"）。自查有效性后，行为完全可控。
 */
function stepMatch(view: EditorView, backwards: boolean): boolean {
  const query = getSearchQuery(view.state);
  if (!query.valid) return false;
  const matches = collectMatches(view, query);
  if (matches.length === 0) return false;
  const sel = view.state.selection.main;
  // 起点语义（对齐 VS Code）：当前光标**正好选中某个命中**时才跳到它的下一个，
  // 否则落到"从光标位置起的第一个命中"——光标停在文档开头时，第一次「下一个」应命中第一处。
  const onMatch = matches.some((m) => m.from === sel.from && m.to === sel.to);
  let index: number;
  if (!backwards) {
    index = matches.findIndex((m) => (onMatch ? m.from > sel.from : m.from >= sel.from));
    if (index === -1) index = 0; // 到底了回到第一个
  } else {
    let found = -1;
    for (let i = 0; i < matches.length; i += 1) {
      const before = onMatch ? matches[i].to < sel.from : matches[i].to <= sel.from;
      if (before) found = i;
      else break;
    }
    index = found === -1 ? matches.length - 1 : found; // 到顶了回到最后一个
  }
  const match = matches[index];
  view.dispatch({
    selection: EditorSelection.single(match.from, match.to),
    effects: EditorView.scrollIntoView(match.from, { y: "center" }),
    userEvent: "select.search",
  });
  view.focus();
  return true;
}

/** 当前是否深色（跟随应用主题的 resolved 值；system 由 theme.ts 解析）。 */
function isDarkTheme(): boolean {
  return useTheme().resolvedTheme.value === "dark";
}

/** 保存图片并在指定位置插入引用（多张按顺序串行，避免并发重名）。 */
async function insertImages(view: EditorView, files: File[], at: number): Promise<void> {
  const ctx = readDocContext(view.state);
  if (!ctx || !canSaveImages()) return;
  let offset = 0;
  for (const file of files) {
    try {
      const saved = await saveImageFile(ctx.root, ctx.rel, file);
      view.dispatch({
        changes: { from: at + offset, insert: saved.markdown + "\n" },
      });
      offset += saved.markdown.length + 1;
      pushToast({ kind: "success", message: t("kb.insertImageDone", { name: saved.name }) }, 2500);
    } catch (error) {
      pushToast({ kind: "error", message: t("kb.insertImageFailed", { reason: String(error) }) });
    }
  }
}

/** 菜单锚点：优先用事件坐标（真右键），否则退回光标位置（键盘触发）。 */
function caretPoint(view: EditorView, x?: number, y?: number): { x: number; y: number } {
  if (x !== undefined && y !== undefined) return { x, y };
  const coords = view.coordsAtPos(view.state.selection.main.head);
  return coords ? { x: coords.left, y: coords.bottom } : { x: 120, y: 160 };
}

/** 1 基的行列（与 VS Code 的状态栏口径一致）。 */
function cursorOf(state: EditorState): { line: number; col: number } {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from + 1 };
}

/** 打开光标所在表格的网格编辑器（SoloMD Editor.vue:2530 同款：文档文本 + 行偏移算范围）。 */
function openTableAtCursor(): void {
  if (!view) return;
  const source = view.state.doc.toString();
  const lines = source.split("\n");
  const caret = view.state.selection.main.head;
  const starts: number[] = [];
  let off = 0;
  for (const line of lines) {
    starts.push(off);
    off += line.length + 1;
  }
  let caretLine = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i] <= caret) caretLine = i;
    else break;
  }
  const span = findTableSpan(lines, caretLine);
  if (!span) {
    // 不在表内：把「插入空表」与「编辑表格」统一成一个动作（SoloMD 同语义）——
    // 打开空表的网格编辑器，应用时插到光标处
    openTableEditor({
      source: "",
      apply: (markdown: string) => {
        const v = view!;
        const pos = v.state.selection.main.head;
        const needLeadingNl = pos > 0 && v.state.doc.lineAt(pos - 1).text !== "";
        const insert = (needLeadingNl ? "\n\n" : "") + markdown + "\n";
        v.dispatch({
          changes: { from: pos, insert },
          selection: { anchor: pos + insert.length },
        });
        v.focus();
      },
    });
    return;
  }
  const from = starts[span.startLine];
  const to = starts[span.endLine] + lines[span.endLine].length;
  openTableEditor({
    source: source.slice(from, to),
    apply: (markdown: string) => {
      const v = view!;
      v.dispatch({
        changes: { from, to, insert: markdown },
        selection: { anchor: from + markdown.length },
      });
      v.focus();
    },
  });
}

defineExpose({
  openTableAtCursor,
  getText: () => view?.state.doc.toString() ?? "",
  /** 大纲点击 → 跳到该行并聚焦。 */
  goToLine: (line: number) => {
    if (!view) return;
    const clamped = Math.min(Math.max(line + 1, 1), view.state.doc.lines);
    const target = view.state.doc.line(clamped);
    view.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "start", yMargin: 24 }),
    });
    view.focus();
  },
  /** 设置查询（含替换文本与开关）；空查询即清除高亮。 */
  setFindQuery: (config: { search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }) => {
    if (!view) return;
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery(config)) });
  },
  clearFindQuery: () => {
    if (!view) return;
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "", replace: "" })) });
  },
  findNext: () => (view ? stepMatch(view, false) : false),
  findPrevious: () => (view ? stepMatch(view, true) : false),
  /** 替换类命令仍用 CM6 实现（正则组引用 `$1` 要它内部的 getReplacement），
   *  但**先自检有效性**——否则同样会因 `searchCommand` 的 else 分支弹出默认面板。 */
  replaceNext: () => (view && getSearchQuery(view.state).valid ? replaceNext(view) : false),
  replaceAllMatches: () => (view && getSearchQuery(view.state).valid ? replaceAll(view) : false),
  /** 命中统计：总数 + 当前序号（1 基；0 = 光标不在命中上）。 */
  findStatus: (): { total: number; current: number } => {
    if (!view) return { total: 0, current: 0 };
    const query = getSearchQuery(view.state);
    if (!query.valid) return { total: 0, current: 0 };
    const anchor = view.state.selection.main.from;
    const matches = collectMatches(view, query);
    const current = matches.filter((m) => m.from <= anchor).length;
    return { total: matches.length, current };
  },
  focus: () => view?.focus(),
  indentWidth: INDENT_WIDTH,
  /** 供面板头工具条与右键菜单调用（同一份命令表）。
   *  「画图」不是文本命令：转给宿主打开空白画布（保存后宿主在光标处插入引用）。 */
  runCommand: (command: MarkdownCommand) => {
    if (!view) return false;
    if (command.key === "draw") {
      emit("draw");
      return true;
    }
    return runCommand(view, command);
  },
  /** 当前光标在文档中的偏移（宿主插入引用用）。 */
  cursorOffset: () => (view ? view.state.selection.main.head : 0),
});
</script>

<template>
  <div ref="host" class="md-editor" />
</template>

<style scoped>
.md-editor {
  height: 100%;
  min-height: 0;
  overflow: hidden;
  /* 中文优先字体栈（不打包 UI 字库；KaTeX 数学字体由 katex.css 自带） */
  --kb-sans: -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  --kb-mono: "SF Mono", Menlo, Consolas, "JetBrains Mono", monospace;
}
.md-editor :deep(.cm-editor) {
  height: 100%;
}
.md-editor :deep(.cm-scroller) {
  font-family: var(--kb-sans);
}
</style>
