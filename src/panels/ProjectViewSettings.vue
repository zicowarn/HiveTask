<script setup lang="ts">
/**
 * ⚙ 视图设置弹层（对齐 GitHub Projects 的 View 面板）：
 * 主面板 = [图标 标签 当前值 ›] 可点行；子面板并排出现在左侧（GitHub 同款），
 * 内为勾选行。行的可用集随布局分派——「分列方式」只在 Board 布局出现，
 * 「字段」的可选项也按布局给（Board 渲染在卡片上，Table 决定列）。
 */
import { computed, ref } from "vue";
import { useProjectsStore } from "../stores/projects";
import { resolvePanel } from "../workbench/registry";
import { useI18n } from "../i18n";
import EditorIcon from "../components/EditorIcon.vue";
import DropdownMenu from "../components/DropdownMenu.vue";

defineProps<{ layout: string }>();

const store = useProjectsStore();
const { t } = useI18n();

type Panel = null | "fields" | "column" | "lane" | "sum" | "sort";

// ---- Layout 分段（平台在 View 弹层顶部：Table / Board / Roadmap）----
// 选项由 registry 里已注册的布局决定——Roadmap 落地后自动出现。
const layoutOptions = computed(() =>
  (resolvePanel("project.board").modes ?? []).map((m) => ({
    key: m.key,
    labelKey: m.labelKey,
    icon:
      m.key === "table" ? "o.layout-table" : m.key === "roadmap" ? "o.layout-roadmap" : "o.layout-board",
  })),
);
const panel = ref<Panel>(null);
function toggle(p: Exclude<Panel, null>) {
  panel.value = panel.value === p ? null : p;
}

// ---- 字段（多选；固定字段 + 引用字段 + 项目字段三段，每段标题只出现一次）----
const sectionTitle = (section: string) =>
  section === "entity"
    ? t("project.fieldSectionEntity")
    : section === "project"
      ? t("project.fieldSectionProject")
      : "";
const fieldGroups = computed(() => {
  const groups: { title: string; items: { id: string; name: string }[] }[] = [];
  for (const f of store.fieldCatalogue) {
    const title = sectionTitle(f.section);
    const last = groups[groups.length - 1];
    if (!last || last.title !== title) groups.push({ title, items: [] });
    groups[groups.length - 1]!.items.push({ id: f.id, name: f.name });
  }
  return groups;
});
const fieldsValue = computed(() =>
  store.fieldCatalogue
    .filter((f) => store.view.fields.includes(f.id as never))
    .map((f) => f.name)
    .join(", "),
);

// ---- 新建字段（＋ 行：名称 + 类型 + 单选选项；落到 app.db 后立即显示）----
const adding = ref(false);
const newName = ref("");
const newKind = ref<"single_select" | "text" | "number" | "date">("single_select");
const newOptions = ref("");
const createError = ref("");
const kindChoices = computed(() => [
  { value: "single_select", label: t("project.fieldTypeSingle") },
  { value: "text", label: t("project.fieldTypeText") },
  { value: "number", label: t("project.fieldTypeNumber") },
  { value: "date", label: t("project.fieldTypeDate") },
]);
function openAdd() {
  adding.value = true;
  newName.value = "";
  newOptions.value = "";
  createError.value = "";
}
async function submitAdd() {
  createError.value = "";
  const options = newOptions.value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    await store.createField(newName.value, newKind.value, options);
    adding.value = false;
  } catch (e) {
    createError.value = String(e);
  }
}

// ---- 分列方式（单选：项目内单选类字段）----
const columnChoices = computed(() =>
  store.columnFieldChoices.map((f) => ({ value: f.id, label: f.name })),
);
function pickColumn(id: string) {
  store.setColumnFieldId(id === store.statusField?.id ? null : id);
  panel.value = null;
}
const columnValue = computed(() => store.columnField?.name ?? "");

// ---- 泳道（单选：项目内单选类字段；null = 不分泳道）----
/** 分组字段候选（含图标，GitHub 的 Group by 面板形态）。 */
const laneFieldChoices = computed(() =>
  store.columnFieldChoices.map((f) => ({
    value: f.id,
    label: f.name,
    icon: f.kind === "builtin_status" ? "view.column" : "view.fields",
  })),
);
function pickLane(id: string) {
  store.setSwimlaneFieldId(id === "" ? null : id);
  panel.value = null;
}
const laneValue = computed(() => store.swimlaneField?.name ?? t("project.none"));


// ---- 字段求和（多选：计数 + 数字字段）----
const sumChoices = computed(() => [
  { id: "count", name: t("project.sumCount") },
  ...store.numberFields.map((f) => ({ id: store.fieldCatalogue.find((c) => c.id === f.id)?.id ?? f.id, name: f.name })),
]);
const sumValue = computed(() =>
  sumChoices.value.filter((s) => store.view.sumFieldIds.includes(s.id)).map((s) => s.name).join(", ") ||
  t("project.none"),
);

// ---- 排序（单选 + 方向；方向只对非手动排序有意义）----
const sortChoices = computed(() => [
  { value: "priority" as const, label: t("project.sortPriority"), dir: true },
  { value: "added" as const, label: t("project.sortAdded"), dir: true },
  { value: "manual" as const, label: t("project.sortManual"), dir: false },
]);
const sortValue = computed(() => {
  const label = sortChoices.value.find((o) => o.value === store.view.sortBy)?.label ?? "";
  if (store.view.sortBy === "manual") return label;
  return `${label} ${store.view.sortDesc ? "↓" : "↑"}`;
});
function pickSort(v: "manual" | "priority" | "added") {
  store.setSortBy(v);
  if (v === "manual") store.setSortDesc(false);
  panel.value = null;
}
</script>

<template>
  <div class="vs">
    <!-- 子面板：与主面板并排、出现在左侧 -->
    <div v-if="panel" class="vs-pop vs-sub">
      <p class="vs-title">
        <template v-if="panel === 'fields'">{{ t("project.viewFields") }}</template>
        <template v-else-if="panel === 'column'">{{ t("project.viewColumnBy") }}</template>
        <template v-else-if="panel === 'lane'">{{ t("project.groupBy") }}</template>
        <template v-else-if="panel === 'sum'">{{ t("project.viewFieldSum") }}</template>
        <template v-else>{{ t("project.viewSort") }}</template>
      </p>
      <p v-if="panel === 'sort'" class="vs-hint">{{ t("project.viewSortHint") }}</p>

      <div v-if="panel === 'fields'" class="vs-list">
        <div class="vs-row" role="menuitem" @click="openAdd()">
          <span class="vs-check plus">＋</span>
          <span class="vs-label">{{ t("project.fieldAdd") }}</span>
        </div>
        <div v-if="adding" class="vs-form">
          <input v-model="newName" class="vs-input" :placeholder="t('project.fieldNamePlaceholder')" />
          <DropdownMenu
            class="vs-form-dd"
            :options="kindChoices"
            :model-value="newKind"
            @update:model-value="newKind = ($event as typeof newKind)"
          />
          <input
            v-if="newKind === 'single_select'"
            v-model="newOptions"
            class="vs-input"
            :placeholder="t('project.fieldOptionsHint')"
          />
          <p v-if="createError" class="vs-error">{{ createError }}</p>
          <div class="vs-form-actions">
            <button class="vs-btn" @click="adding = false">{{ t("conn.cancel") }}</button>
            <button class="vs-btn primary" :disabled="!newName.trim()" @click="submitAdd">
              {{ t("issue.submit") }}
            </button>
          </div>
        </div>
        <div v-for="(group, gi) in fieldGroups" :key="gi" class="vs-group">
          <p v-if="group.title" class="vs-section">{{ group.title }}</p>
          <div
            v-for="f in group.items"
            :key="f.id"
            class="vs-row"
            role="menuitemcheckbox"
            :aria-checked="store.view.fields.includes(f.id as never)"
            @click="store.toggleField(f.id as never)"
          >
            <span class="vs-check box" :class="{ on: store.view.fields.includes(f.id as never) }">✓</span>
            <span class="vs-label">{{ f.name }}</span>
          </div>
        </div>
      </div>

      <div v-else-if="panel === 'column'" class="vs-list">
        <div
          v-for="f in columnChoices"
          :key="f.value"
          class="vs-row"
          role="menuitemradio"
          :aria-checked="store.columnField?.id === f.value"
          @click="pickColumn(f.value)"
        >
          <span class="vs-check" :class="{ on: store.columnField?.id === f.value }">✓</span>
          <span class="vs-label">{{ f.label }}</span>
        </div>
      </div>

      <div v-else-if="panel === 'lane'" class="vs-list">
        <div
          v-for="f in laneFieldChoices"
          :key="f.value"
          class="vs-row"
          role="menuitemradio"
          :aria-checked="(store.swimlaneField?.id ?? '') === f.value"
          @click="pickLane(f.value)"
        >
          <span class="vs-check" :class="{ on: (store.swimlaneField?.id ?? '') === f.value }">✓</span>
          <EditorIcon :name="f.icon" />
          <span class="vs-label">{{ f.label }}</span>
        </div>
        <div class="vs-sep"></div>
        <div
          class="vs-row"
          role="menuitemradio"
          :aria-checked="!store.swimlaneField"
          @click="pickLane('')"
        >
          <span class="vs-check" :class="{ on: !store.swimlaneField }">✓</span>
          <span class="vs-label">{{ t("project.noGrouping") }}</span>
        </div>
      </div>

      <div v-else-if="panel === 'sum'" class="vs-list">
        <div
          v-for="s in sumChoices"
          :key="s.id"
          class="vs-row"
          role="menuitemcheckbox"
          :aria-checked="store.view.sumFieldIds.includes(s.id)"
          @click="store.toggleSum(s.id)"
        >
          <span class="vs-check box" :class="{ on: store.view.sumFieldIds.includes(s.id) }">✓</span>
          <span class="vs-label">{{ s.name }}</span>
        </div>
      </div>

      <div v-else class="vs-list">
        <div
          v-for="o in sortChoices"
          :key="o.value"
          class="vs-row"
          role="menuitemradio"
          :aria-checked="store.view.sortBy === o.value"
          @click="pickSort(o.value)"
        >
          <span class="vs-check" :class="{ on: store.view.sortBy === o.value }">✓</span>
          <span class="vs-label">{{ o.label }}</span>
          <button
            v-if="o.dir && store.view.sortBy === o.value"
            class="vs-dir"
            :title="store.view.sortDesc ? t('project.sortDesc') : t('project.sortAsc')"
            @click.stop="store.setSortDesc(!store.view.sortDesc)"
          >
            {{ store.view.sortDesc ? "↓" : "↑" }}
          </button>
        </div>
      </div>
    </div>

    <!-- 主面板 -->
    <div class="vs-pop vs-main">
      <!-- Layout 分段（平台形态：等宽按钮 + 图标，选中态填充） -->
      <div class="vs-layout-seg">
        <button
          v-for="opt in layoutOptions"
          :key="opt.key"
          class="vs-layout-btn"
          :class="{ active: store.layout === opt.key }"
          @click="store.setLayout(opt.key as never)"
        >
          <EditorIcon :name="opt.icon" />
          {{ t(opt.labelKey) }}
        </button>
      </div>
      <div class="vs-row" role="menuitem" @click="toggle('fields')">
        <EditorIcon class="vs-icon" name="o.view-fields" />
        <span class="vs-label">{{ t("project.viewFields") }}</span>
        <span class="vs-value">{{ fieldsValue }}</span>
        <EditorIcon class="vs-chev" name="chevron" />
      </div>

      <div v-if="layout === 'board'" class="vs-row" role="menuitem" @click="toggle('column')">
        <EditorIcon class="vs-icon" name="o.view-column" />
        <span class="vs-label">{{ t("project.viewColumnBy") }}</span>
        <span class="vs-value">{{ columnValue }}</span>
        <EditorIcon class="vs-chev" name="chevron" />
      </div>

      <div v-if="layout === 'board'" class="vs-row" role="menuitem" @click="toggle('lane')">
        <EditorIcon class="vs-icon" name="o.view-swimlanes" />
        <span class="vs-label">{{ t("project.viewSwimlanes") }}</span>
        <span class="vs-value">{{ laneValue }}</span>
        <EditorIcon class="vs-chev" name="chevron" />
      </div>

      <div class="vs-row" role="menuitem" @click="toggle('sort')">
        <EditorIcon class="vs-icon" name="o.view-sort" />
        <span class="vs-label">{{ t("project.viewSort") }}</span>
        <span class="vs-value">{{ sortValue }}</span>
        <EditorIcon class="vs-chev" name="chevron" />
      </div>

      <div class="vs-row" role="menuitem" @click="toggle('sum')">
        <EditorIcon class="vs-icon" name="o.view-sum" />
        <span class="vs-label">{{ t("project.viewFieldSum") }}</span>
        <span class="vs-value">{{ sumValue }}</span>
        <EditorIcon class="vs-chev" name="chevron" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 弹层整体：主面板贴触发器右缘，子面板并排在其左侧（GitHub 同款排布） */
.vs {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 30;
  display: flex;
  align-items: flex-start;
  gap: 4px;
}
.vs-pop {
  width: 300px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
/* Layout 分段：等宽三格，选中态填充 + 600 字重（照平台） */
.vs-layout-seg {
  display: flex;
  gap: 8px;
  margin: 2px 4px 6px;
}
.vs-layout-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: var(--font-base);
  font-family: inherit;
  cursor: pointer;
}
.vs-layout-btn:hover {
  background: var(--bg-hover);
}
.vs-layout-btn.active {
  background: var(--bg-selected);
  font-weight: 600;
}
.vs-title {
  margin: 2px 6px 4px;
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.vs-hint {
  margin: 0 6px 6px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 分节标题（字段面板的「项目字段」，对齐 GitHub 的小标题） */
.vs-section {
  margin: 6px 8px 2px;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-dim);
}
.vs-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}
.vs-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
/* 行：图标 + 标签 + 当前值 + ›（值截断，右侧留 chevron） */
.vs-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  min-width: 0;
}
.vs-row:hover {
  background: var(--bg-hover);
}
.vs-icon {
  color: var(--text-dim);
}
.vs-label {
  font-size: var(--font-base);
  color: var(--text);
  white-space: nowrap;
}
/* 主面板行：标签带冒号（GitHub 的 "Sort by: value" 形态） */
.vs-main .vs-label::after {
  content: ":";
}
.vs-value {
  margin-left: auto;
  min-width: 0;
  font-size: var(--font-base);
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vs-chev {
  color: var(--text-dim);
}
/* 勾选位：单选 ✓ / 多选方框（无值时留空占位，行首对齐） */
.vs-check {
  flex: none;
  width: 14px;
  text-align: center;
  color: var(--accent);
  font-size: var(--font-base);
  visibility: hidden;
}
.vs-check.on {
  visibility: visible;
}
.vs-check.box {
  width: 12px;
  height: 12px;
  line-height: 12px;
  font-size: var(--font-xs);
  border: 1px solid var(--border);
  border-radius: 3px;
  visibility: visible;
}
.vs-check.box.on {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--bg-panel);
}
.vs-check.plus {
  visibility: visible;
  color: var(--text-dim);
}
/* ＋ 新建字段的行内表单 */
.vs-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 8px 8px;
}
.vs-input {
  box-sizing: border-box;
  width: 100%;
  font-size: var(--font-base);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 5px 8px;
  outline: none;
}
.vs-input:focus {
  border-color: var(--accent);
}
.vs-form-dd {
  width: 100%;
}
.vs-error {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--danger);
}
.vs-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.vs-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  height: 24px;
  padding: 0 10px;
  border-radius: 5px;
  cursor: pointer;
}
.vs-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.vs-btn.primary {
  border-color: var(--accent);
  color: var(--accent);
}
.vs-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 排序方向：行内小按钮（不能嵌在 button 里，行是 div） */
.vs-dir {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-base);
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
}
.vs-dir:hover {
  color: var(--accent);
  background: var(--bg-selected);
}
</style>
