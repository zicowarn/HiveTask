<script setup lang="ts">
/**
 * Board view — columns come from the builtin_status field's options (the
 * data-defined workflow, not hardcoded columns); cards drag between/within
 * columns (HTML5 DnD → backend computes a fractional rank midpoint).
 * Card body: draft title or `#number title` with a repo/ghost tag; priority
 * renders as a colored dot from the single-select field's option color.
 */
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { useProjectsStore } from "../../stores/projects";
import { api, type ProjectItem } from "../../api";
import { useI18n } from "../../i18n";

const store = useProjectsStore();
const { statusField, priorityField, selected, filteredItems } = storeToRefs(store);
const { t } = useI18n();

const columns = computed(() => store.statusOptions());

/** 列 → 该列卡片（过滤+排序后的投影，按字段值分组）。 */
function cardsOf(optionId: string) {
  if (!statusField.value) return [];
  return filteredItems.value.filter((i) => i.fieldValues[statusField.value!.id] === optionId);
}

function priorityColor(item: ProjectItem): string | null {
  if (!priorityField.value) return null;
  const optionId = item.fieldValues[priorityField.value.id];
  if (!optionId) return null;
  return priorityField.value.options.find((o) => o.id === optionId)?.color ?? null;
}

function priorityName(item: ProjectItem): string {
  if (!priorityField.value) return "";
  const optionId = item.fieldValues[priorityField.value.id];
  return priorityField.value.options.find((o) => o.id === optionId)?.name ?? "";
}

/** 卡片主标题：草稿显示草稿题；引用卡无缓存标题时回落 #编号。 */
function titleOf(item: ProjectItem): string {
  if (item.draftTitle) return item.draftTitle;
  return item.number ? `#${item.number}` : "";
}

// ---- 卡片点击：引用卡跳线上 Issue（切仓库上下文 + 打开详情） ----
function openCard(item: ProjectItem) {
  if (item.kind === "draft" || item.ghost || !item.repoId || !item.number) return;
  store.navRequest = { workspace: "issues", repoId: item.repoId, number: item.number };
}

/** 卡片第一行元信息：引用卡 = 仓库标签；草稿 = 草稿标记。 */
function metaOf(item: ProjectItem): string {
  if (item.ghost) return t("project.ghost");
  if (item.kind === "draft") return t("project.draftTag");
  return item.repoLabel ?? "";
}

// ---- 列内快加（＋ 直接展开底部表单并锁定目标列） ----
const addColumn = ref<string | null>(null);
function quickAdd(optionId: string) {
  addColumn.value = optionId;
  addOpen.value = true;
}

// ---- 列改名（⋯ 菜单，走 options 重写） ----
const renamingCol = ref<string | null>(null);
const renameColName = ref("");
function startRenameCol(optionId: string, current: string) {
  renamingCol.value = optionId;
  renameColName.value = current;
}
async function submitRenameCol() {
  if (!renamingCol.value || !renameColName.value.trim()) return;
  await store.renameStatusOption(renamingCol.value, renameColName.value.trim());
  renamingCol.value = null;
}

// ---- 拖拽：dragover 记录落点（列 + 参照卡），drop 一次性提交 ----
const dragId = ref<string | null>(null);
const dropTarget = ref<{ optionId: string; prevId: string | null } | null>(null);

function onDragStart(item: ProjectItem, event: DragEvent) {
  dragId.value = item.id;
  event.dataTransfer?.setData("text/plain", item.id);
}
function onDragOverColumn(optionId: string, event: DragEvent) {
  event.preventDefault();
  dropTarget.value = { optionId, prevId: lastCardId(optionId) };
}
function onDragOverCard(optionId: string, item: ProjectItem, event: DragEvent) {
  if (dragId.value === item.id) return;
  event.preventDefault();
  event.stopPropagation();
  dropTarget.value = { optionId, prevId: item.id };
}
function onDrop(event: DragEvent) {
  event.preventDefault();
  const id = dragId.value;
  const target = dropTarget.value;
  dragId.value = null;
  dropTarget.value = null;
  if (!id || !target) return;
  void store.moveItem(id, target.optionId, target.prevId ?? undefined, undefined);
}
function lastCardId(optionId: string): string | null {
  const cards = cardsOf(optionId);
  return cards.length ? cards[cards.length - 1]!.id : null;
}

// ---- 添加条目 ----
const addOpen = ref(false);
const addKind = ref<"draft" | "issue">("draft");
const addTitle = ref("");
const addBody = ref("");
const addRepoId = ref("");
const addNumber = ref("");
/** 引用形态的仓库下拉数据：已登记仓库（含远端），label 与 id 对齐看板外键。 */
const repoChoices = ref<{ id: string; label: string }[]>([]);
async function toggleAdd() {
  addOpen.value = !addOpen.value;
  if (addOpen.value && repoChoices.value.length === 0) {
    try {
      const rows = (await api.repoList()) as Array<{ id: string; displayName?: string | null; path?: string | null; remoteUrl?: string | null }>;
      repoChoices.value = rows.map((r) => ({
        id: r.id,
        label: r.displayName ?? r.path?.split("/").filter(Boolean).pop() ?? r.remoteUrl ?? r.id,
      }));
    } catch {
      repoChoices.value = [];
    }
  }
}
async function submitAdd() {
  if (!selected.value) return;
  let created = null;
  if (addKind.value === "draft") {
    if (!addTitle.value.trim()) return;
    created = await store.addItem({ projectId: selected.value.id, kind: "draft", draftTitle: addTitle.value, draftBody: addBody.value || undefined });
  } else {
    if (!addRepoId.value || !addNumber.value.trim()) return;
    created = await store.addItem({ projectId: selected.value.id, kind: "issue", repoId: addRepoId.value, number: addNumber.value.trim() });
  }
  // 列内快加：落点锁定到触发的列
  if (created && addColumn.value) {
    await store.moveItem(created.id, addColumn.value);
  }
  addTitle.value = "";
  addBody.value = "";
  addNumber.value = "";
}

// ---- 草稿转 Issue ----
const converting = ref<string | null>(null);
const localRepos = ref<{ path: string; label: string }[]>([]);
async function toggleConvert(item: ProjectItem) {
  converting.value = converting.value === item.id ? null : item.id;
  if (converting.value && localRepos.value.length === 0) {
    try {
      const rows = (await api.repoList()) as Array<{ path?: string | null; displayName?: string | null; remoteUrl?: string | null }>;
      localRepos.value = rows
        .filter((r) => r.path && !r.remoteUrl)
        .map((r) => ({ path: r.path!, label: r.displayName ?? r.path!.split("/").filter(Boolean).pop()! }));
    } catch {
      localRepos.value = [];
    }
  }
}
async function submitConvert(item: ProjectItem, path: string) {
  await store.convertToIssue(item.id, path);
  converting.value = null;
}
</script>

<template>
  <div class="board" @drop="onDrop" @dragover.prevent>
    <div
      v-for="col in columns"
      :key="col.id"
      class="col"
      @dragover="onDragOverColumn(col.id, $event)"
    >
      <p class="col-head">
        <span class="col-dot" :style="{ background: col.color }"></span>
        <template v-if="renamingCol === col.id">
          <input
            v-model="renameColName"
            class="col-rename"
            @keydown.enter="submitRenameCol"
            @keydown.escape="renamingCol = null"
          />
          <button class="col-btn" @click="submitRenameCol">✓</button>
        </template>
        <template v-else>
          {{ col.name }}
          <span class="col-count">{{ cardsOf(col.id).length }}</span>
          <span class="col-spacer"></span>
          <button class="col-btn" :title="t('project.renameCol')" @click="startRenameCol(col.id, col.name)">⋯</button>
          <button class="col-btn plus" :title="t('project.addHere')" @click="quickAdd(col.id)">＋</button>
        </template>
      </p>
      <div
        v-for="card in cardsOf(col.id)"
        :key="card.id"
        class="card"
        :class="{ ghosty: card.ghost, dropping: dropTarget?.prevId === card.id, clickable: card.kind !== 'draft' && !card.ghost }"
        draggable="true"
        @dragstart="onDragStart(card, $event)"
        @dragover="onDragOverCard(col.id, card, $event)"
        @click="openCard(card)"
      >
        <p class="card-meta">
          <span class="card-src">{{ metaOf(card) }}</span>
          <span
            v-if="priorityColor(card)"
            class="prio-dot"
            :style="{ background: priorityColor(card) ?? '' }"
            :title="priorityName(card)"
          ></span>
          <button class="card-del" :title="t('project.removeItem')" @click.stop="store.removeItem(card.id)">✕</button>
        </p>
        <p class="card-title">{{ titleOf(card) }}</p>
        <div v-if="card.kind === 'draft'" class="card-convert">
          <button class="card-link" @click="toggleConvert(card)">{{ t("project.convert") }}</button>
          <template v-if="converting === card.id">
            <select
              class="card-select"
              @change="submitConvert(card, ($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled selected>{{ t("project.pickLocalRepo") }}</option>
              <option v-for="r in localRepos" :key="r.path" :value="r.path">{{ r.label }}</option>
            </select>
          </template>
        </div>
      </div>
      <p
        v-if="dropTarget?.optionId === col.id && dropTarget?.prevId === null"
        class="drop-hint"
      >↓</p>
    </div>

    <div class="add-pane">
      <button class="add-toggle" @click="toggleAdd">{{ addOpen ? "×" : "+" }}</button>
      <div v-if="addOpen" class="add-form">
        <div class="add-kind">
          <button class="kind-tab" :class="{ active: addKind === 'draft' }" @click="addKind = 'draft'">
            {{ t("project.addDraft") }}
          </button>
          <button class="kind-tab" :class="{ active: addKind === 'issue' }" @click="addKind = 'issue'">
            {{ t("project.addRef") }}
          </button>
        </div>
        <template v-if="addKind === 'draft'">
          <input v-model="addTitle" class="add-input" :placeholder="t('issue.titlePlaceholder')" @keydown.enter="submitAdd" />
          <input v-model="addBody" class="add-input" :placeholder="t('issue.bodyPlaceholder')" @keydown.enter="submitAdd" />
        </template>
        <template v-else>
          <select v-model="addRepoId" class="add-input">
            <option value="" disabled>{{ t("project.pickRepo") }}</option>
            <option v-for="r in repoChoices" :key="r.id" :value="r.id">{{ r.label }}</option>
          </select>
          <input v-model="addNumber" class="add-input" :placeholder="t('project.numberPlaceholder')" @keydown.enter="submitAdd" />
        </template>
        <button class="add-submit" :disabled="addKind === 'draft' ? !addTitle.trim() : !addRepoId || !addNumber.trim()" @click="submitAdd">
          {{ t("issue.submit") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.board {
  display: flex;
  gap: 8px;
  flex: 1;
  min-height: 0;
  padding: 10px;
  overflow-x: auto;
  align-items: stretch;
  position: relative;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 240px;
  flex: none;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  overflow-y: auto;
}
.col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.col-rename {
  box-sizing: border-box;
  width: 110px;
  font-size: 12px;
  font-family: inherit;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 1px 5px;
  outline: none;
}
.col-spacer {
  flex: 1;
}
.col-btn {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  padding: 0 3px;
  border-radius: 4px;
}
.col-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.col-btn.plus {
  font-size: 13px;
}
.col-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.col-count {
  margin-left: auto;
  font-size: 10px;
  font-weight: 400;
  color: var(--text-dim);
}
.card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 9px;
  cursor: grab;
}
.card:active {
  cursor: grabbing;
}
.card.ghosty {
  opacity: 0.55;
  border-style: dashed;
}
.card.dropping {
  border-color: var(--accent);
}
.card.clickable:hover {
  border-color: var(--accent);
}
.card-title {
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--text);
  word-break: break-word;
}
.card-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 4px;
  font-size: 10px;
  color: var(--text-dim);
}
.card-src {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.prio-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.card-del {
  display: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 10px;
  cursor: pointer;
}
.card:hover .card-del {
  display: inline;
}
.card-del:hover {
  color: var(--danger);
}
.card-convert {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
}
.card-link {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}
.card-select {
  font-size: 11px;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 4px;
  max-width: 140px;
}
.drop-hint {
  margin: 0;
  text-align: center;
  color: var(--accent);
  font-size: 12px;
}
.add-pane {
  position: absolute;
  right: 14px;
  bottom: 14px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.add-toggle {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px dashed var(--border);
  background: var(--bg-panel);
  color: var(--text-dim);
  font-size: 16px;
  cursor: pointer;
}
.add-toggle:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.add-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 260px;
  padding: 10px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}
.add-kind {
  display: flex;
  gap: 2px;
}
.kind-tab {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  padding: 4px 0;
  border-radius: 4px;
  cursor: pointer;
}
.kind-tab.active {
  background: var(--bg-selected);
  color: var(--accent);
  font-weight: 600;
}
.add-input {
  box-sizing: border-box;
  width: 100%;
  font-size: 12px;
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 5px 8px;
  outline: none;
}
.add-input:focus {
  border-color: var(--accent);
}
.add-submit {
  border: 1px solid var(--accent);
  color: var(--accent);
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  height: 24px;
  border-radius: 5px;
  cursor: pointer;
}
.add-submit:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
