<script setup lang="ts">
/**
 * 代码文件编辑器（.py/.rs/.ts/.json/…）—— CM6 骨架与 MarkdownEditor 同源：
 * 行号 / 查找（宿主查找条）/ IME 友好 / 明暗主题联动 / Tab 缩进。
 *
 * 与 MarkdownEditor 的差别（刻意精简）：无 live-preview、无公式图表、无图片粘贴、
 * 无大纲——代码文件要的是「可编辑 + 语法着色 + 行号」。语法高亮走
 * `code-languages.ts` 的 CM6 语言包（认识就着色，不认识也不影响编辑）。
 *
 * 脏标记与保存由宿主（KnowledgePreview）接管：`update:modelValue` 上报文本，
 * 宿主沿用 Markdown 的 kbWriteText 链路（含 mtime 冲突检测与编码回写）。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorSelection, EditorState, Compartment } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
import { search } from "@codemirror/search";
import { codeLanguageFor } from "./code-languages";
import { codeEditorHighlight } from "./code-highlight";

const props = withDefaults(
  defineProps<{
    /** 初始文本（切文件时由父组件换 key 或调 setText）。 */
    modelValue: string;
    /** 文件扩展名（决定语法高亮；不认识就纯文本）。 */
    ext: string;
    readonly?: boolean;
    /** 缩进宽度（状态栏显示同源）。 */
    indentWidth?: number;
  }>(),
  { readonly: false, indentWidth: 4 },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  /** 光标行列（1 基）——状态栏显示；失焦时传 null。 */
  cursor: [value: { line: number; col: number } | null];
  /** 右键：把菜单锚点交给宿主渲染（与 MarkdownEditor 同款，拒绝 WebView 系统菜单）。 */
  contextmenu: [payload: { x: number; y: number }];
}>();

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
const readOnlyCompartment = new Compartment();
const darkThemeCompartment = new Compartment();
const languageCompartment = new Compartment();
const indentCompartment = new Compartment();

function isDarkTheme(): boolean {
  // useTheme 的 resolved 值已在 <html data-theme> 上；直接读它，避免再建响应式依赖
  return document.documentElement.dataset.theme !== "light";
}

function extensions() {
  return [
    lineNumbers(),
    history(),
    darkThemeCompartment.of(EditorView.darkTheme.of(isDarkTheme())),
    languageCompartment.of(codeLanguageFor(props.ext) ?? []),
    codeEditorHighlight,
    search(),
    keymap.of([
      { key: "Mod-/", run: (view) => toggleLineComment(view, LINE_COMMENTS[props.ext.toLowerCase()] ?? "//") },
      { key: "Shift-Alt-ArrowDown", run: (view) => copyLineDown(view) },
      { key: "Shift-Alt-ArrowUp", run: (view) => copyLineUp(view) },
      { key: "Alt-ArrowUp", run: (view) => moveLines(view, false) },
      { key: "Alt-ArrowDown", run: (view) => moveLines(view, true) },
      { key: "Mod-Shift-k", run: (view) => deleteLine(view) },
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    indentCompartment.of(indentUnit.of(" ".repeat(props.indentWidth))),
    readOnlyCompartment.of(EditorState.readOnly.of(props.readonly === true)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) emit("update:modelValue", update.state.doc.toString());
      if (update.selectionSet || update.docChanged || update.focusChanged) {
        emit("cursor", update.view.hasFocus ? cursorOf(update.state) : null);
      }
    }),
    EditorView.domEventHandlers({
      blur: () => {
        emit("cursor", null);
        return false;
      },
      // 右键 → 宿主的命令菜单（拒绝 WKWebView 的系统文本菜单；全局拦截器对
      // contenteditable 放行，所以这里必须自己 preventDefault）
      contextmenu: (event, view) => {
        event.preventDefault();
        emit("contextmenu", caretPoint(view, event.clientX, event.clientY));
        return true;
      },
      // 键盘可达：Shift+F10 / 菜单键打开同一份菜单
      keydown: (event, view) => {
        if (!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return false;
        event.preventDefault();
        let anchor = { x: 0, y: 0 };
        try {
          const coords = view.coordsAtPos(view.state.selection.main.head);
          if (coords) anchor = { x: coords.left, y: coords.bottom };
        } catch {
          // 无布局环境回退 (0,0)
        }
        emit("contextmenu", anchor);
        return true;
      },
    }),
    EditorView.theme({
      "&": { height: "100%", fontSize: "var(--font-md)" },
      ".cm-scroller": {
        fontFamily: "'SF Mono', Menlo, Consolas, monospace",
        lineHeight: "1.6",
        overflow: "auto",
      },
      ".cm-content": { padding: "12px 0", caretColor: "var(--accent)" },
      ".cm-line": { padding: "0 16px" },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "var(--text-dim)",
        border: "none",
      },
    }),
  ];
}

function cursorOf(state: EditorState): { line: number; col: number } {
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  return { line: line.number, col: pos - line.from + 1 };
}

// ---- VS Code 式行操作（判据：选中行范围含换行时按多行处理；空选 = 当前行） ----

/** 当前选择覆盖的行范围（含仅光标时的那一行）。 */
function selectedLines(state: EditorState): { from: number; to: number } {
  const range = state.selection.main;
  const fromLine = state.doc.lineAt(range.from);
  const toLine = state.doc.lineAt(range.to);
  return { from: fromLine.from, to: toLine.to };
}

function copyLineDown(view: EditorView): boolean {
  const { from, to } = selectedLines(view.state);
  const text = view.state.doc.sliceString(from, to);
  const toLine = view.state.doc.lineAt(to);
  const insertAt = toLine.to;
  view.dispatch({
    changes: { from: insertAt, insert: "\n" + text },
    selection: { anchor: view.state.selection.main.head + text.length + 1 },
    scrollIntoView: true,
  });
  return true;
}

function copyLineUp(view: EditorView): boolean {
  const { from, to } = selectedLines(view.state);
  const text = view.state.doc.sliceString(from, to);
  const fromLine = view.state.doc.lineAt(from);
  view.dispatch({
    changes: { from: fromLine.from, insert: text + "\n" },
    selection: { anchor: view.state.selection.main.head },
    scrollIntoView: true,
  });
  return true;
}

function moveLines(view: EditorView, down: boolean): boolean {
  const { from, to } = selectedLines(view.state);
  const text = view.state.doc.sliceString(from, to);
  if (down) {
    const next = view.state.doc.lineAt(to + 1 <= view.state.doc.length ? to + 1 : to);
    if (next.to <= to && next.number === view.state.doc.lines && to >= next.to) return true; // 已是最后一行
    const below = view.state.doc.lineAt(Math.min(to + 1, view.state.doc.length));
    if (below.number === toLineNumber(view.state, to)) return true;
    view.dispatch({
      changes: [
        { from: below.from, to: below.to, insert: text },
        { from, to, insert: below.text },
      ],
      selection: { anchor: below.from + (view.state.selection.main.head - from) },
    });
    return true;
  }
  const above = view.state.doc.lineAt(Math.max(from - 1, 0));
  if (above.number === view.state.doc.lineAt(from).number) return true; // 已是第一行
  view.dispatch({
    changes: [
      { from, to, insert: above.text },
      { from: above.from, to: above.to, insert: text },
    ],
    selection: { anchor: above.from + (view.state.selection.main.head - from) },
  });
  return true;
}

function toLineNumber(state: EditorState, pos: number): number {
  return state.doc.lineAt(pos).number;
}

function deleteLine(view: EditorView): boolean {
  const { from, to } = selectedLines(view.state);
  const toLine = view.state.doc.lineAt(to);
  const removeTo = Math.min(toLine.to + 1, view.state.doc.length); // 连换行一起删
  view.dispatch({ changes: { from, to: removeTo }, scrollIntoView: true });
  return true;
}

/**
 * 切换行注释：按扩展名选行注释符（`//`、`#`、`--`…）；已注释则去掉，否则加上。
 * 判定口径：选区内每一行都以（空白+）注释符开头 → 全部去掉；否则全部加上。
 */
function toggleLineComment(view: EditorView, comment: string): boolean {
  const { from, to } = selectedLines(view.state);
  const lines: { from: number; to: number; text: string }[] = [];
  for (let pos = from; pos <= to; ) {
    const line = view.state.doc.lineAt(pos);
    lines.push(line);
    pos = line.to + 1;
  }
  const marker = comment + " ";
  const bare = comment;
  const allCommented = lines.every((line) => {
    const trimmed = line.text.trimStart();
    return trimmed.startsWith(bare);
  });
  const changes: { from: number; to?: number; insert?: string }[] = [];
  if (allCommented) {
    for (const line of lines) {
      const idx = line.text.indexOf(comment);
      // 去掉注释符 + 紧随的一个空格（若存在）
      const after = idx + comment.length;
      const extra = line.text[after] === " " ? 1 : 0;
      changes.push({ from: line.from + idx, to: line.from + after + extra, insert: "" });
    }
  } else {
    // 加在各自最小缩进处
    const indents = lines.map((line) => line.text.length - line.text.trimStart().length);
    const common = Math.min(...indents);
    for (const line of lines) changes.push({ from: line.from + common, insert: marker });
  }
  view.dispatch({ changes, scrollIntoView: true });
  return true;
}

/** 扩展名 → 行注释符。 */
const LINE_COMMENTS: Record<string, string> = {
  js: "//", mjs: "//", cjs: "//", jsx: "//", ts: "//", mts: "//", cts: "//", tsx: "//",
  json: "//", json5: "//", css: "/*", less: "//", scss: "//",
  html: "<!--", htm: "<!--", vue: "<!--", xml: "<!--",
  py: "#", pyw: "#", sh: "#", bash: "#", yaml: "#", yml: "#", toml: "#", rb: "#", r: "#",
  rs: "//", c: "//", h: "//", cpp: "//", cc: "//", cxx: "//", hpp: "//", java: "//",
  go: "//", swift: "//", dart: "//", kt: "//", php: "//", cs: "//",
  lua: "--", sql: "--", haskell: "--", elixir: "#", erlang: "%", perl: "#",
};

/** 右键锚点：优先取事件坐标处的光标（右键落在别的行时先把光标挪过去），换算成视口坐标。 */
function caretPoint(view: EditorView, clientX: number, clientY: number): { x: number; y: number } {
  let coords: { left: number; bottom: number } | null = null;
  try {
    const pos = view.posAtCoords({ x: clientX, y: clientY });
    if (pos != null) view.dispatch({ selection: EditorSelection.cursor(pos) });
    // jsdom 无真实布局（getClientRects 缺失）→ coordsAtPos 会抛，回退事件坐标
    coords = view.coordsAtPos(pos ?? view.state.selection.main.head);
  } catch {
    coords = null;
  }
  return coords ? { x: coords.left, y: coords.bottom } : { x: clientX, y: clientY };
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    state: EditorState.create({ doc: props.modelValue, extensions: extensions() }),
    parent: host.value,
  });
});

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});

watch(
  () => props.modelValue,
  (value) => {
    if (!view || value === view.state.doc.toString()) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  },
);

watch(
  () => props.ext,
  (ext) => {
    view?.dispatch({
      effects: languageCompartment.reconfigure(codeLanguageFor(ext) ?? []),
    });
  },
);

/** 外部覆盖缓冲（宿主「重新载入」冲突出口）。 */
function setText(value: string): void {
  if (!view) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
}

/**
 * 剪贴板三件套：CM6 没有可编程的 cut/copy/paste 命令（浏览器安全模型要求这些
 * 必须来自用户手势）——右键菜单的点击本身就是手势，用 Selection API + clipboard
 * API 完成：剪切/复制取选区文本；粘贴读剪贴板替换选区。
 */
async function clipboardAction(action: "cut" | "copy" | "paste"): Promise<void> {
  if (!view) return;
  view.focus();
  const range = view.state.selection.main;
  const selected = view.state.sliceDoc(range.from, range.to);
  try {
    if (action === "copy") {
      await navigator.clipboard.writeText(selected);
      return;
    }
    if (action === "cut") {
      await navigator.clipboard.writeText(selected);
      view.dispatch({ changes: { from: range.from, to: range.to, insert: "" } });
      return;
    }
    const text = await navigator.clipboard.readText();
    view.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: { anchor: range.from + text.length } });
  } catch {
    // 剪贴板权限被拒 → 静默（用户仍可用系统 ⌘X/⌘C/⌘V）
  }
}

/** 右键菜单动作分发（宿主把 `code:*` 转发到这里）。 */
function runAction(action: string): void {
  if (!view) return;
  view.focus();
  switch (action) {
    case "undo": undo(view); break;
    case "redo": redo(view); break;
    case "cut": void clipboardAction("cut"); break;
    case "copy": void clipboardAction("copy"); break;
    case "paste": void clipboardAction("paste"); break;
    case "copy-line-down": copyLineDown(view); break;
    case "copy-line-up": copyLineUp(view); break;
    case "move-line-up": moveLines(view, false); break;
    case "move-line-down": moveLines(view, true); break;
    case "delete-line": deleteLine(view); break;
    case "toggle-comment": toggleLineComment(view, LINE_COMMENTS[props.ext.toLowerCase()] ?? "//"); break;
  }
}

defineExpose({ setText, runAction });
</script>

<template>
  <div ref="host" class="kb-code-editor"></div>
</template>

<style scoped>
.kb-code-editor {
  height: 100%;
  overflow: hidden;
  background: var(--bg-panel);
}
.kb-code-editor :deep(.cm-editor) {
  height: 100%;
}
.kb-code-editor :deep(.cm-editor.cm-focused) {
  outline: none;
}
</style>
