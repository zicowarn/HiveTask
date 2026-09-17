<script setup lang="ts">
/**
 * Table view — the same projected data as the Board, rendered as rows
 * (design: "Board / Table are two projections of the same cached data,
 * no extra storage"). Columns: title / status select / priority dot / repo.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useProjectsStore } from "../../stores/projects";
import type { ProjectField, ProjectItem } from "../../api";
import { useI18n } from "../../i18n";
import DropdownMenu from "../../components/DropdownMenu.vue";
import ActionMenu from "../../components/ActionMenu.vue";

const store = useProjectsStore();
const { filteredItems } = storeToRefs(store);
const { t } = useI18n();

const rows = computed(() => filteredItems.value);

/** 列 = 视图「字段」开关打开的那些，顺序按 store 的字段目录。 */
const columns = computed(() =>
  store.fieldCatalogue.filter((f) => store.view.fields.includes(f.id as never)).map((f) => f.id),
);
function headerOf(id: string): string {
  return store.fieldName(id);
}

/** 单元格：统一走 store.cellOf（固定字段走本地/镜像，项目字段走字段值）。 */
function cellText(id: string, item: ProjectItem): string {
  return store.cellOf(id, item)?.text ?? "—";
}
function cellColor(id: string, item: ProjectItem): string | null {
  return store.cellOf(id, item)?.color ?? null;
}

// ---- 项目字段（含自建）在表格里可就地编辑 ----
function fieldOf(id: string): ProjectField | null {
  return store.fieldByViewKey(id);
}
function optionChoices(id: string) {
  return (fieldOf(id)?.options ?? []).map((o) => ({ value: o.id, label: o.name, color: o.color }));
}
function valueOf(id: string, item: ProjectItem): string {
  const field = fieldOf(id);
  return field ? (item.fieldValues[field.id] ?? "") : "";
}
function inputType(id: string): string {
  const kind = fieldOf(id)?.kind;
  return kind === "number" ? "number" : kind === "date" ? "date" : "text";
}
// ---- 列头 ⋯（平台的 column options：按字段排序升/降 + 按值筛选）----
/** 当前排序标记（平台在列头显示 ↑/↓）。 */
function sortMark(id: string): string {
  const fs = store.view.fieldSort;
  if (!fs) return "";
  const field = fieldOf(id);
  if (!field || fs.fieldId !== field.id) return "";
  return fs.desc ? "↓" : "↑";
}
function columnMenuItems(id: string) {
  const field = fieldOf(id);
  const items = [
    { value: "asc", label: t("project.actSortAsc"), group: t("project.actGroupColumn") },
    { value: "desc", label: t("project.actSortDesc"), group: t("project.actGroupColumn") },
  ];
  if (field?.options.length) {
    items.push({ value: "clear", label: t("project.actClearSort"), group: t("project.actGroupColumn") });
  }
  return items;
}
async function onColumnPick(id: string, value: string) {
  const field = fieldOf(id);
  if (!field) return;
  if (value === "asc") store.setFieldSort(field.id, false);
  else if (value === "desc") store.setFieldSort(field.id, true);
  else if (value === "clear") store.setFieldSort(null);
}

/** 草稿卡就地保存（标题 + 正文；平台表格/看板均为就地编辑）。 */
function saveDraft(item: ProjectItem, title: string, body: string) {
  if (!title.trim()) return;
  void store.updateDraft(item.id, title.trim(), body);
}

function commit(id: string, item: ProjectItem, value: string) {
  const field = fieldOf(id);
  if (!field) return;
  void store.setFieldValue(item.id, field.id, value.trim() ? value : undefined);
}

/** 行点击 = 打开 item 抽屉（平台形态）；就地编辑控件上的点击不触发。 */
function onRowClick(item: ProjectItem, event: MouseEvent) {
  const el = event.target as HTMLElement | null;
  if (el?.closest("input, button, select, textarea, .dd")) return;
  store.openPanelItem(item.id);
}
</script>

<template>
  <div class="tbl-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th v-for="col in columns" :key="col" :class="{ 'th-title': col === 'title' }">
            <span class="th-cell">
              {{ headerOf(col) }}
              <span v-if="sortMark(col)" class="th-sort">{{ sortMark(col) }}</span>
              <ActionMenu
                v-if="fieldOf(col)"
                trigger-icon="ellipsis"
                :title="t('project.actColumnMenu')"
                :items="columnMenuItems(col)"
                @pick="onColumnPick(col, $event)"
              />
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="item in rows"
          :key="item.id"
          :class="{ ghosty: item.ghost }"
          @click="onRowClick(item, $event)"
        >
          <td v-for="col in columns" :key="col" :class="{ 'td-title': col === 'title', 'td-src': col === 'source' }">
            <!-- 草稿卡的标题/正文就地编辑（平台在表格里就是就地编辑） -->
            <input
              v-if="col === 'title' && item.kind === 'draft'"
              class="cell-input"
              :value="item.draftTitle ?? ''"
              @change="saveDraft(item, ($event.target as HTMLInputElement).value, item.draftBody ?? '')"
            />
            <DropdownMenu
              v-if="fieldOf(col) && (fieldOf(col)?.kind === 'single_select' || fieldOf(col)?.kind === 'builtin_status')"
              class="cell-dd"
              :options="optionChoices(col)"
              :model-value="valueOf(col, item)"
              placeholder="—"
              @update:model-value="commit(col, item, $event as string)"
            />
            <input
              v-else-if="fieldOf(col)"
              class="cell-input"
              :type="inputType(col)"
              :value="valueOf(col, item)"
              @change="commit(col, item, ($event.target as HTMLInputElement).value)"
            />
            <span v-else-if="cellColor(col, item)" class="prio-chip" :style="{ borderColor: cellColor(col, item) ?? '' }">
              {{ cellText(col, item) }}
            </span>
            <template v-else>{{ cellText(col, item) }}</template>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="rows.length === 0" class="tbl-empty">{{ t("project.noItems") }}</p>
  </div>
</template>

<style scoped>
.tbl-wrap {
  flex: 1;
  overflow: auto;
  padding: 10px;
}
.tbl {
  /* 平台实测：列宽固定（Title 650 + 其余 200），表体横向滚动，不挤压首列 */
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: var(--font-lg);
}
/* 列头：平台实测 12px / 600 / 高 34px */
th {
  text-align: left;
  color: var(--text);
  font-size: var(--font-md);
  font-weight: 600;
  height: 34px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
/* 其余列固定 200px（平台实测） */
th:not(.th-title),
td:not(.td-title) {
  width: 200px;
  min-width: 200px;
}
.th-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.th-sort {
  color: var(--accent);
  font-size: var(--font-sm);
}
.th-title,
.td-title {
  width: 650px;
  min-width: 650px; /* 平台实测 Title 列 650px */
}
/* 单元格：平台实测 14px；行分隔为发丝线 */
td {
  height: 34px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-size: var(--font-lg);
}
tr.ghosty td {
  opacity: 0.55;
}
.td-title {
  word-break: break-word;
}
.td-src {
  color: var(--text-dim);
}
/* 行点击打开 item 抽屉（平台形态） */
tbody tr {
  cursor: pointer;
}
tbody tr:hover td {
  background: var(--bg-hover);
}
.cell-select {
  font-size: var(--font-md);
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 4px;
}
.prio-chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 600;
  background: var(--bg-selected);
  color: var(--accent);
  border: 1px solid transparent;
}
/* 项目字段的就地编辑控件（下拉 / 文本·数字·日期输入） */
.cell-dd {
  min-width: 96px;
}
.cell-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 80px;
  font-size: var(--font-md);
  font-family: inherit;
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 3px 6px;
  outline: none;
}
.cell-input:hover {
  border-color: var(--border);
}
.cell-input:focus {
  border-color: var(--accent);
  background: var(--bg-app);
}
.tbl-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: var(--font-md);
  padding: 24px 0;
}
</style>
