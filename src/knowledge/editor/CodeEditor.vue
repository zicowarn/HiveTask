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
import { EditorState, Compartment } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
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
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
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

defineExpose({ setText });
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
