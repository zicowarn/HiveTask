<script setup lang="ts">
/**
 * Markdown 表格的网格编辑对话框 —— 逐文件对照移植自 SoloMD
 * `app/src/components/TableEditor.vue`（MIT, © 2026 xiangdong li，见 THIRD-PARTY.md）。
 *
 * 为什么要有它：把表格当文本编辑是 Markdown 最劝退的一环——加一列意味着给每行
 * 重打一遍竖线，漏一个 `|` 整个表就静默变回段落。这里按网格编辑，应用时写回
 * 列对齐的、格式良好的 Markdown（列宽按 CJK 双宽计算，见 markdown-table.ts）。
 *
 * 在点「应用」之前不会碰文档 —— session 的 `apply` 闭包是唯一写路径，「取消」
 * 就是丢弃工作副本。样式改走本仓库 token（对话框形态与 KnowledgeConvertDialog 同源）。
 */
import { computed, nextTick, ref, watch } from "vue";
import {
  parseTable,
  serializeTable,
  insertRow,
  deleteRow,
  moveRow,
  insertColumn,
  deleteColumn,
  moveColumn,
  setAlign,
  setCell,
  emptyTable,
  type TableAlign,
  type TableModel,
} from "./markdown-table";
import { t } from "../../i18n";
import EditorIcon from "../../components/EditorIcon.vue";

const props = defineProps<{ source: string }>();
const emit = defineEmits<{
  (e: "apply", markdown: string): void;
  (e: "close"): void;
}>();

const model = ref<TableModel>(parseTable(props.source) ?? emptyTable());
/** 行/列按钮作用的目标列。-1 表示光标在表头——表头也是一列，只是行号不同。 */
const focused = ref<{ row: number; col: number }>({ row: -1, col: 0 });
const gridEl = ref<HTMLElement | null>(null);

watch(
  () => props.source,
  (next) => {
    model.value = parseTable(next) ?? emptyTable();
    focused.value = { row: -1, col: 0 };
  },
);

const preview = computed(() => serializeTable(model.value));
const colCount = computed(() => model.value.header.length);

const ALIGNS: Array<{ value: TableAlign; label: string }> = [
  { value: null, label: "─" },
  { value: "left", label: "⟵" },
  { value: "center", label: "↔" },
  { value: "right", label: "⟶" },
];

function onCellInput(row: number, col: number, e: Event) {
  const value = (e.target as HTMLElement).innerText;
  model.value = setCell(model.value, row, col, value);
}

function focusCell(row: number, col: number) {
  focused.value = { row, col };
}

/** 结构变化后把焦点放回网格，键盘不落到页面上。 */
async function refocus(row: number, col: number) {
  focused.value = { row, col };
  await nextTick();
  const sel = `[data-cell="${row}:${col}"]`;
  (gridEl.value?.querySelector(sel) as HTMLElement | null)?.focus();
}

function addRowBelow() {
  const at = focused.value.row + 1;
  model.value = insertRow(model.value, at);
  void refocus(at, focused.value.col);
}
function addRowAbove() {
  const at = Math.max(0, focused.value.row);
  model.value = insertRow(model.value, at);
  void refocus(at, focused.value.col);
}
function removeRow() {
  if (focused.value.row < 0) return;
  const at = focused.value.row;
  model.value = deleteRow(model.value, at);
  void refocus(Math.min(at, model.value.rows.length - 1), focused.value.col);
}
function rowUp() {
  const at = focused.value.row;
  if (at <= 0) return;
  model.value = moveRow(model.value, at, at - 1);
  void refocus(at - 1, focused.value.col);
}
function rowDown() {
  const at = focused.value.row;
  if (at < 0 || at >= model.value.rows.length - 1) return;
  model.value = moveRow(model.value, at, at + 1);
  void refocus(at + 1, focused.value.col);
}

function addColRight() {
  const at = focused.value.col + 1;
  model.value = insertColumn(model.value, at);
  void refocus(focused.value.row, at);
}
function addColLeft() {
  const at = focused.value.col;
  model.value = insertColumn(model.value, at);
  void refocus(focused.value.row, at);
}
function removeCol() {
  const at = focused.value.col;
  model.value = deleteColumn(model.value, at);
  void refocus(focused.value.row, Math.min(at, model.value.header.length - 1));
}
function colLeft() {
  const at = focused.value.col;
  if (at <= 0) return;
  model.value = moveColumn(model.value, at, at - 1);
  void refocus(focused.value.row, at - 1);
}
function colRight() {
  const at = focused.value.col;
  if (at >= model.value.header.length - 1) return;
  model.value = moveColumn(model.value, at, at + 1);
  void refocus(focused.value.row, at + 1);
}
function chooseAlign(a: TableAlign) {
  model.value = setAlign(model.value, focused.value.col, a);
}

function apply() {
  emit("apply", serializeTable(model.value));
  emit("close");
}

/**
 * Tab 在单元格间循环（网格该有的行为）；Esc 取消；单元格内 Enter 被吞掉——
 * 换行会把一行表格劈成两行。⌘/Ctrl+Enter 应用。
 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
    return;
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) apply();
    return;
  }
  if (e.key !== "Tab") return;
  const { row, col } = focused.value;
  e.preventDefault();
  const cols = colCount.value;
  let flat = (row + 1) * cols + col + (e.shiftKey ? -1 : 1);
  const total = (model.value.rows.length + 1) * cols;
  flat = ((flat % total) + total) % total;
  void refocus(Math.floor(flat / cols) - 1, flat % cols);
}
</script>

<template>
  <div class="tbl__backdrop" @click.self="emit('close')" @keydown="onKeydown">
    <div class="tbl" role="dialog" aria-modal="true">
      <header class="tbl__head">
        <span class="tbl__title">{{ t("tableEditor.heading") }}</span>
        <span class="tbl__size">{{ colCount }} × {{ model.rows.length }}</span>
        <button class="tbl__x" :title="t('tableEditor.cancel')" @click="emit('close')">
          <EditorIcon name="o.x" />
        </button>
      </header>

      <div class="tbl__toolbar">
        <div class="tbl__group">
          <span class="tbl__grouplabel">{{ t("tableEditor.row") }}</span>
          <button @click="addRowAbove" :title="t('tableEditor.rowAbove')">↑+</button>
          <button @click="addRowBelow" :title="t('tableEditor.rowBelow')">↓+</button>
          <button @click="rowUp" :title="t('tableEditor.rowUp')">⤒</button>
          <button @click="rowDown" :title="t('tableEditor.rowDown')">⤓</button>
          <button class="tbl__danger" @click="removeRow" :title="t('tableEditor.rowDelete')">✕</button>
        </div>
        <div class="tbl__group">
          <span class="tbl__grouplabel">{{ t("tableEditor.column") }}</span>
          <button @click="addColLeft" :title="t('tableEditor.colLeft')">+←</button>
          <button @click="addColRight" :title="t('tableEditor.colRight')">+→</button>
          <button @click="colLeft" :title="t('tableEditor.colMoveLeft')">⇤</button>
          <button @click="colRight" :title="t('tableEditor.colMoveRight')">⇥</button>
          <button class="tbl__danger" @click="removeCol" :title="t('tableEditor.colDelete')">✕</button>
        </div>
        <div class="tbl__group">
          <span class="tbl__grouplabel">{{ t("tableEditor.align") }}</span>
          <button
            v-for="a in ALIGNS"
            :key="String(a.value)"
            :class="{ tbl__on: model.aligns[focused.col] === a.value }"
            @click="chooseAlign(a.value)"
          >{{ a.label }}</button>
        </div>
      </div>

      <div class="tbl__gridwrap" ref="gridEl">
        <table class="tbl__grid">
          <thead>
            <tr>
              <th
                v-for="(cell, c) in model.header"
                :key="`h${c}`"
                :class="{ tbl__focus: focused.row === -1 && focused.col === c }"
              >
                <div
                  class="tbl__cell"
                  contenteditable="plaintext-only"
                  :data-cell="`-1:${c}`"
                  :style="{ textAlign: model.aligns[c] ?? 'left' }"
                  @focus="focusCell(-1, c)"
                  @input="(e) => onCellInput(-1, c, e)"
                >{{ cell }}</div>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, r) in model.rows" :key="`r${r}`">
              <td
                v-for="(cell, c) in row"
                :key="`c${r}-${c}`"
                :class="{ tbl__focus: focused.row === r && focused.col === c }"
              >
                <div
                  class="tbl__cell"
                  contenteditable="plaintext-only"
                  :data-cell="`${r}:${c}`"
                  :style="{ textAlign: model.aligns[c] ?? 'left' }"
                  @focus="focusCell(r, c)"
                  @input="(e) => onCellInput(r, c, e)"
                >{{ cell }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <details class="tbl__preview">
        <summary>{{ t("tableEditor.preview") }}</summary>
        <pre>{{ preview }}</pre>
      </details>

      <footer class="tbl__foot">
        <span class="tbl__hint">{{ t("tableEditor.hint") }}</span>
        <button class="tbl__btn" @click="emit('close')">{{ t("tableEditor.cancel") }}</button>
        <button class="tbl__btn tbl__btn--primary" @click="apply">{{ t("tableEditor.apply") }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.tbl__backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}
.tbl {
  display: flex;
  flex-direction: column;
  width: min(720px, 88vw);
  max-height: 84vh;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
}
.tbl__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.tbl__title {
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.tbl__size {
  flex: 1;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.tbl__x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.tbl__x:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.tbl__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 18px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}
.tbl__group {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tbl__grouplabel {
  margin-right: 2px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.tbl__toolbar button {
  min-width: 26px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-sm);
  cursor: pointer;
}
.tbl__toolbar button:hover {
  border-color: var(--accent);
}
.tbl__on {
  border-color: var(--accent) !important;
  color: var(--accent);
}
.tbl__danger:hover {
  border-color: var(--danger) !important;
  color: var(--danger);
}
.tbl__gridwrap {
  overflow: auto;
  padding: 10px 14px;
}
.tbl__grid {
  border-collapse: collapse;
}
.tbl__grid th,
.tbl__grid td {
  border: 1px solid var(--border);
  padding: 0;
}
.tbl__grid th {
  background: var(--bg-chip);
}
.tbl__focus {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.tbl__cell {
  min-width: 90px;
  max-width: 260px;
  min-height: 26px;
  padding: 4px 8px;
  font-size: var(--font-md);
  color: var(--text);
  outline: none;
  white-space: pre-wrap;
}
.tbl__preview {
  padding: 4px 14px;
  border-top: 1px solid var(--border);
}
.tbl__preview summary {
  font-size: var(--font-sm);
  color: var(--text-dim);
  cursor: pointer;
}
.tbl__preview pre {
  margin: 6px 0;
  padding: 8px;
  overflow: auto;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: var(--font-sm);
  color: var(--text-dim);
  background: var(--bg-app);
  border-radius: 5px;
}
.tbl__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
}
.tbl__hint {
  flex: 1;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.tbl__btn {
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  cursor: pointer;
}
.tbl__btn:hover {
  border-color: var(--accent);
}
.tbl__btn--primary {
  border-color: var(--btn-primary);
  background: var(--btn-primary);
  color: #fff;
}
.tbl__btn--primary:hover {
  border-color: var(--btn-primary-hover);
  background: var(--btn-primary-hover);
}
</style>
