<script setup lang="ts">
/**
 * 甘特图 Editor（宿主面板）——2026-09-21 起内部拆 Mode：**任务 / 资源 / 负载**
 * （用户定案：同一批条目 × 资源分配的不同编队 = Mode；《甘特计划面》§5-bis）。
 *
 * 宿主职责：Editor 外壳、mode 标签（PanelShell `#switcher`）、工具条（字段映射 +
 * 刻度 + 溢出折叠）、任务编辑面板、把共享状态（`gantt-state.ts`）接到各 Mode。
 * 领域状态在 projects store；甘特特有派生状态在共享层——**切 Mode 不重置**。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import "jordium-gantt-vue3/index.css"; // 库样式：只在宿主导入一次（Vite 去重）
import { api, type ProjectItem } from "../api";
import PanelShell from "../workbench/PanelShell.vue";
import ModeTabs from "../components/ModeTabs.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import ActionMenu, { type ActionItem } from "../components/ActionMenu.vue";
import EditorIcon from "../components/EditorIcon.vue";
import GanttTaskEditor from "./GanttTaskEditor.vue";
import { resolvePanel } from "../workbench/registry";
import { useProjectsStore } from "../stores/projects";
import { useGanttState } from "./gantt-state";
import { useI18n } from "../i18n";
import { translateError } from "../gh-errors";
import { pushToast } from "../toast";
import { foldToolbarDecision, type TaskFormPayload } from "./gantt-model";

const props = defineProps<{ leafId?: string; panelType?: string }>();
void props;

const store = useProjectsStore();
const g = useGanttState();
const { t, locale } = useI18n();
const { selectedId, loading: storeLoading } = storeToRefs(store);
const {
  dateFields,
  numberFields,
  startField,
  endField,
  actualStartField,
  actualEndField,
  estHoursField,
  actHoursField,
  progressField,
  nodes,
  relationsLoading,
  relationsError,
  loadRelations,
  undatedCount,
} = g;

// ---- Mode：任务 / 资源 / 负载（与 issue.list 同款：modeKey + localStorage 持久化）----
const MODE_STORAGE_KEY = "hivetask.gantt-mode";
const modes = resolvePanel("project.gantt").modes ?? [];
const storedMode = modes.find((m) => m.key === localStorage.getItem(MODE_STORAGE_KEY))?.key ?? modes[0]?.key;
const modeKey = ref(storedMode ?? "task");
watch(modeKey, (key) => localStorage.setItem(MODE_STORAGE_KEY, key));
const activeMode = computed(() => modes.find((m) => m.key === modeKey.value) ?? modes[0]);

// ---- 刻度 ----
type GanttScale = "hour" | "day" | "week" | "month" | "quarter" | "year";
const scale = ref<GanttScale>("week");
const scaleOptions = computed(() => [
  { value: "day", label: t("gantt.scaleDay") },
  { value: "week", label: t("gantt.scaleWeek") },
  { value: "month", label: t("gantt.scaleMonth") },
]);

// ---- 工具条溢出折叠（窄面板 → 「字段」多级菜单；判定抽成纯函数有测试）----
const toolbarEl = ref<HTMLElement | null>(null);
const toolbarCollapsed = ref(false);
const toolbarNeeded = ref(0);
const EXPAND_SLACK = 24;

/** 内在宽度：排除撑开项后子项宽 + 间距 + 内边距。
 *  不能用 scrollWidth——容器够宽时撑开项会填满，会把 fill 宽度误记成所需宽度。 */
function intrinsicToolbarWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const gap = Number.parseFloat(style.columnGap || style.gap || "0") || 0;
  const pad = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  const kids = [...el.children] as HTMLElement[];
  let sum = pad + gap * Math.max(0, kids.length - 1);
  for (const k of kids) {
    if (k.classList.contains("gt-flex")) continue;
    sum += k.offsetWidth;
  }
  return sum;
}

function measureToolbar() {
  const el = toolbarEl.value;
  if (!el) return;
  if (!toolbarCollapsed.value) {
    const needed = intrinsicToolbarWidth(el);
    if (needed > 0) toolbarNeeded.value = needed;
  }
  const basis = toolbarNeeded.value || intrinsicToolbarWidth(el);
  const next = foldToolbarDecision(toolbarCollapsed.value, basis, el.clientWidth, EXPAND_SLACK);
  if (next !== null) toolbarCollapsed.value = next;
}

let toolbarRO: ResizeObserver | null = null;
onMounted(() => {
  void g.loadRepos();
  void loadRelations();
  if (typeof ResizeObserver !== "undefined" && toolbarEl.value) {
    toolbarRO = new ResizeObserver(() => measureToolbar());
    toolbarRO.observe(toolbarEl.value);
  }
  void nextTick(measureToolbar);
});
onBeforeUnmount(() => {
  toolbarRO?.disconnect();
  toolbarRO = null;
});
watch([() => dateFields.value.length, locale, () => toolbarCollapsed.value], () => void nextTick(measureToolbar));
watch(selectedId, () => void loadRelations());

/** 折叠态多级菜单：每行一个映射项，二级面板列候选（当前值 ✓）。 */
const collapsedMenuItems = computed<ActionItem[]>(() => {
  const dateOpts = (current: string | null, allowNone: boolean): ActionItem[] => [
    ...(allowNone ? [{ value: "none", label: t("project.none"), checked: !current }] : []),
    ...dateFields.value.map((f) => ({ value: f.id, label: f.name, checked: f.id === current })),
  ];
  const numOpts = (current: string): ActionItem[] => [
    { value: "none", label: t("project.none"), checked: !current },
    ...numberFields.value.map((f) => ({ value: f.id, label: f.name, checked: f.id === current })),
  ];
  return [
    { value: "m:start", label: t("gantt.startField"), submenu: dateOpts(startField.value?.id ?? null, false) },
    { value: "m:end", label: t("gantt.endField"), submenu: dateOpts(endField.value?.id ?? null, true) },
    { value: "m:actualStart", label: t("gantt.actualStartField"), submenu: dateOpts(actualStartField.value?.id ?? null, true) },
    { value: "m:actualEnd", label: t("gantt.actualEndField"), submenu: dateOpts(actualEndField.value?.id ?? null, true) },
    { value: "m:estHours", label: `${t("gantt.hoursField")}·${t("gantt.estHours")}`, submenu: numOpts(estHoursField.value?.id ?? "") },
    { value: "m:actHours", label: `${t("gantt.hoursField")}·${t("gantt.actHours")}`, submenu: numOpts(actHoursField.value?.id ?? "") },
    { value: "m:progress", label: t("gantt.progressField"), submenu: numOpts(progressField.value?.id ?? "") },
    {
      value: "m:scale",
      label: t("gantt.scale"),
      dividerBefore: true,
      submenu: scaleOptions.value.map((o) => ({ ...o, checked: o.value === scale.value })),
    },
  ];
});

function onCollapsedMenuPick(value: string) {
  const [key, id = ""] = value.split(":");
  const landed = id === "none" || id === "" ? "" : id;
  switch (key) {
    case "m:start":
      if (landed) g.startFieldId.value = landed;
      return;
    case "m:end":
      g.endFieldChoice.value = landed;
      return;
    case "m:actualStart":
      g.actualStartFieldId.value = landed;
      return;
    case "m:actualEnd":
      g.actualEndFieldId.value = landed;
      return;
    case "m:estHours":
      g.estHoursFieldId.value = landed;
      return;
    case "m:actHours":
      g.actHoursFieldId.value = landed;
      return;
    case "m:progress":
      g.progressFieldId.value = landed;
      return;
    case "m:scale":
      return void (scale.value = id as GanttScale);
  }
}

// ---- 新增任务（容器草稿 + 播种 今天→+3 天）----
async function addSeededTask() {
  if (!selectedId.value) return;
  const item = await store.addItem({
    projectId: selectedId.value,
    kind: "draft",
    draftTitle: t("gantt.newTaskName"),
  });
  const start = new Date();
  const end = new Date(start.getTime() + 3 * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  try {
    if (startField.value) await store.setFieldValue(item.id, startField.value.id, iso(start));
    if (endField.value) await store.setFieldValue(item.id, endField.value.id, iso(end));
  } catch (e) {
    pushToast({ kind: "error", message: translateError(String(e)) });
  }
}

// ---- 任务编辑面板（应用风格；字段集照甘特库任务表单）----
const editorItem = ref<ProjectItem | null>(null);
const editorOpen = ref(false);
const editorRef = ref<InstanceType<typeof GanttTaskEditor> | null>(null);

function openTaskEditor(nodeId: string) {
  const item = g.filteredItems.value.find((i) => i.id === nodeId);
  if (!item) return;
  editorItem.value = item;
  editorOpen.value = true;
}

const editorMapping = computed(() => ({
  startFieldId: startField.value?.id ?? null,
  endFieldId: endField.value?.id ?? null,
  actualStartFieldId: actualStartField.value?.id ?? null,
  actualEndFieldId: actualEndField.value?.id ?? null,
  estHoursFieldId: estHoursField.value?.id ?? null,
  actHoursFieldId: actHoursField.value?.id ?? null,
  progressFieldId: progressField.value?.id ?? null,
}));

const editorCandidates = computed(() =>
  nodes.value
    .filter((n) => n.id !== editorItem.value?.id)
    .map((n) => ({ id: n.id, label: n.number ? `#${n.number} ${n.title}` : n.title })),
);

const editorDeps = computed(() => {
  const id = editorItem.value?.id;
  return id ? (g.nodeById.value.get(id)?.dependsOn ?? []) : [];
});

const editorParentId = computed(() => {
  const id = editorItem.value?.id;
  return (id ? g.nodeById.value.get(id)?.parentId : null) ?? null;
});

const editorResources = computed(() => {
  const id = editorItem.value?.id;
  return id ? (store.itemResources[id] ?? []) : [];
});

const editorKindText = computed(() => {
  const it = editorItem.value;
  if (!it) return "";
  if (it.kind === "draft") return t("gantt.kindDraft");
  if (it.kind === "pull") return `PR #${it.number ?? ""}`;
  return `Issue #${it.number ?? ""}`;
});

async function onTaskSave(payload: TaskFormPayload) {
  const item = editorItem.value;
  if (!item) return;
  const repoPath = item.repoId ? g.repoPathOf(item.repoId) : null;
  const platformish = item.kind !== "draft" && !!repoPath && !!item.number;
  try {
    // 标题 / 描述
    if (item.kind === "draft") {
      await store.updateDraft(item.id, payload.title, payload.body);
    } else if (platformish) {
      const node = g.nodeById.value.get(item.id);
      if (payload.title !== node?.title || payload.body) {
        await api.updateIssue(repoPath, item.number!, payload.title, payload.body);
      }
    }
    // 资源分配（§5-bis）：分配行 diff + 类别写回资源目录
    const before = editorResources.value.map((r) => r.resourceId);
    for (const row of payload.resources) {
      const prev = editorResources.value.find((r) => r.resourceId === row.resourceId);
      if (!prev || prev.allocation !== row.allocation) {
        await store.setItemResource(item.id, row.resourceId, row.allocation);
      }
    }
    for (const gone of before.filter((id) => !payload.resources.some((r) => r.resourceId === id))) {
      await store.removeItemResource(item.id, gone);
    }
    // 平台条目：把「平台派生资源」的名字同步为 issue assignees（§5-bis 写路径）
    if (platformish) {
      const names = payload.resources
        .map((r) => store.resourceCatalog.find((c) => c.id === r.resourceId))
        .filter((r) => r && r.origin)
        .map((r) => r!.name);
      if (names.join(",") !== (item.entity?.assignees ?? []).join(",")) {
        await api.issueUpdateAssignees(repoPath, item.number!, names);
      }
    }
    // 上级任务（结构扩展泳道）
    const currentParent = editorParentId.value;
    if (payload.parentId && payload.parentId !== currentParent) {
      await store.setItemParent(item.id, payload.parentId);
    } else if (!payload.parentId && currentParent) {
      await store.clearItemParent(item.id);
    }
    // 项目字段（未配置映射的跳过——没有落点就不写）
    const m = editorMapping.value;
    const writeField = async (fieldId: string | null, value: string | null) => {
      if (!fieldId || value === null) return;
      await store.setFieldValue(item.id, fieldId, value);
    };
    await writeField(m.startFieldId, payload.plannedStart);
    await writeField(m.endFieldId, payload.plannedEnd);
    await writeField(m.actualStartFieldId, payload.actualStart);
    await writeField(m.actualEndFieldId, payload.actualEnd);
    await writeField(m.estHoursFieldId, payload.estHours === null ? null : String(payload.estHours));
    await writeField(m.actHoursFieldId, payload.actualHours === null ? null : String(payload.actualHours));
    await writeField(m.progressFieldId, payload.progress === null ? null : String(payload.progress));
    // 依赖边 diff（容器/平台分流）
    await g.syncPredecessors(item.id, payload.predecessorIds);
    await loadRelations(true);
    editorRef.value?.done();
  } catch (e) {
    editorRef.value?.fail(translateError(String(e)));
  }
}

async function onTaskRemove(nodeId: string) {
  if (!nodeId) return;
  if (!confirm(t("gantt.removeConfirm"))) return;
  try {
    await store.removeItemAndDeps(nodeId);
    editorRef.value?.done();
  } catch (e) {
    pushToast({ kind: "error", message: translateError(String(e)) });
  }
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template v-if="modes.length > 1" #switcher>
      <ModeTabs v-model="modeKey" :modes="modes" />
    </template>

    <template #actions>
      <span v-if="undatedCount" class="gt-note">{{ t("gantt.undated", { n: String(undatedCount) }) }}</span>
      <span v-if="relationsLoading" class="gt-note">{{ t("gantt.depsLoading") }}</span>
      <button class="gt-add" :title="t('gantt.addTask')" @click="addSeededTask">
        <EditorIcon name="o.plus" />
        <span>{{ t("gantt.addTask") }}</span>
      </button>
      <button class="gt-refresh" :title="t('gantt.refreshDeps')" @click="loadRelations(true)">
        <EditorIcon name="o.sync" />
      </button>
    </template>

    <div class="gt">
      <div v-if="selectedId && dateFields.length" ref="toolbarEl" class="gt-toolbar">
        <template v-if="toolbarCollapsed">
          <span class="gt-label">{{ t("gantt.fields") }}</span>
          <ActionMenu
            :items="collapsedMenuItems"
            trigger-icon="o.sliders"
            :title="t('gantt.fields')"
            align="left"
            @pick="onCollapsedMenuPick"
          />
        </template>
        <template v-else>
          <span class="gt-flex"></span>
          <span class="gt-label">{{ t("gantt.startField") }}</span>
          <DropdownMenu
            class="gt-dd gt-dd-start"
            :options="dateFields.map((f) => ({ value: f.id, label: f.name }))"
            :model-value="startField?.id ?? ''"
            @update:model-value="g.startFieldId.value = $event as string"
          />
          <span class="gt-label">{{ t("gantt.endField") }}</span>
          <DropdownMenu
            class="gt-dd gt-dd-end"
            :options="[{ value: '', label: t('project.none') }, ...dateFields.map((f) => ({ value: f.id, label: f.name }))]"
            :model-value="g.endFieldChoice.value ?? endField?.id ?? ''"
            @update:model-value="g.endFieldChoice.value = $event as string"
          />
          <span class="gt-label">{{ t("gantt.actualStartField") }}</span>
          <DropdownMenu
            class="gt-dd gt-dd-end"
            :options="[{ value: '', label: t('project.none') }, ...dateFields.map((f) => ({ value: f.id, label: f.name }))]"
            :model-value="actualStartField?.id ?? ''"
            @update:model-value="g.actualStartFieldId.value = $event as string"
          />
          <span class="gt-label">{{ t("gantt.actualEndField") }}</span>
          <DropdownMenu
            class="gt-dd gt-dd-end"
            :options="[{ value: '', label: t('project.none') }, ...dateFields.map((f) => ({ value: f.id, label: f.name }))]"
            :model-value="actualEndField?.id ?? ''"
            @update:model-value="g.actualEndFieldId.value = $event as string"
          />
          <span class="gt-label">{{ t("gantt.hoursField") }}</span>
          <DropdownMenu
            class="gt-dd gt-dd-end"
            :options="[{ value: '', label: t('project.none') }, ...numberFields.map((f) => ({ value: f.id, label: f.name }))]"
            :model-value="estHoursField?.id ?? ''"
            @update:model-value="g.estHoursFieldId.value = $event as string"
          />
          <DropdownMenu
            class="gt-dd gt-dd-end"
            :options="[{ value: '', label: t('project.none') }, ...numberFields.map((f) => ({ value: f.id, label: f.name }))]"
            :model-value="actHoursField?.id ?? ''"
            @update:model-value="g.actHoursFieldId.value = $event as string"
          />
          <span class="gt-label">{{ t("gantt.progressField") }}</span>
          <DropdownMenu
            class="gt-dd gt-dd-end"
            :options="[{ value: '', label: t('project.none') }, ...numberFields.map((f) => ({ value: f.id, label: f.name }))]"
            :model-value="progressField?.id ?? ''"
            @update:model-value="g.progressFieldId.value = $event as string"
          />
          <span class="gt-label">{{ t("gantt.scale") }}</span>
          <DropdownMenu
            class="gt-dd gt-dd-scale"
            :options="scaleOptions"
            :model-value="scale"
            @update:model-value="scale = $event as GanttScale"
          />
        </template>
      </div>
      <p v-if="relationsError" class="gt-warn">{{ t("gantt.depsFailed") }}</p>

      <p v-if="!selectedId" class="gt-empty">{{ t("project.empty") }}</p>
      <p v-else-if="!dateFields.length" class="gt-empty">{{ t("roadmap.noDateField") }}</p>
      <p v-else-if="!nodes.length && !storeLoading" class="gt-empty">{{ t("gantt.noItems") }}</p>

      <component
        :is="activeMode!.component"
        v-else
        :key="activeMode!.key"
        :scale="scale"
        :open-editor="openTaskEditor"
        :remove-item="onTaskRemove"
      />
    </div>

    <GanttTaskEditor
      v-if="editorItem"
      ref="editorRef"
      :open="editorOpen"
      :item="editorItem"
      :mapping="editorMapping"
      :resource-catalog="store.resourceCatalog"
      :current-resources="editorResources"
      :candidates="editorCandidates"
      :current-deps="editorDeps"
      :parent-id="editorParentId"
      :kind-text="editorKindText"
      @close="editorOpen = false"
      @save="onTaskSave"
      @remove="onTaskRemove(editorItem?.id ?? '')"
    />
  </PanelShell>
</template>

<style scoped>
.gt {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.gt-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.gt-toolbar > * {
  flex: none;
}
.gt-toolbar > .gt-flex {
  flex: 1;
}
.gt-label {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 右栏动作（PanelShell #actions）：与看板面板的 22px 小按钮同款 */
.gt-refresh,
.gt-add {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  border-radius: 5px;
  cursor: pointer;
}
.gt-refresh:hover,
.gt-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.gt-note {
  font-size: var(--font-sm);
  color: var(--text-dim);
  white-space: nowrap;
}
.gt-warn {
  margin: 0;
  padding: 4px 10px;
  font-size: var(--font-sm);
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.gt-empty {
  margin: 24px auto;
  font-size: var(--font-base);
  color: var(--text-dim);
}
/* 下拉宽度收齐（触发盒内容自适应会参差） */
.gt-dd :deep(.dd-trigger) {
  justify-content: space-between;
}
.gt-dd :deep(.dd-label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gt-dd-start :deep(.dd-trigger) {
  width: 128px;
}
.gt-dd-end :deep(.dd-trigger) {
  width: 104px;
}
.gt-dd-scale :deep(.dd-trigger) {
  width: 72px;
}
</style>

<!-- 主题对齐与库内样式覆盖（非 scoped：变量要走继承压过库内声明） -->
<style>
.gt-jordium,
.gt-jordium .gantt-root[data-theme] {
  --gantt-bg-primary: var(--bg-panel);
  --gantt-bg-secondary: var(--bg-app);
  --gantt-bg-tertiary: var(--bg-app);
  --gantt-bg-light: var(--bg-app);
  --gantt-bg-dark: var(--bg-chip);
  --gantt-bg-darker: var(--bg-hover);
  --gantt-bg-active: var(--bg-selected);
  --gantt-bg-hover: var(--bg-hover);
  --gantt-bg-hover-dark: var(--bg-hover);
  --gantt-bg-hover-parent: var(--bg-hover);
  --gantt-bg-toolbar: var(--bg-panel);
  --gantt-bg-disabled: var(--bg-chip);
  --gantt-text-primary: var(--text);
  --gantt-text-regular: var(--text);
  --gantt-text-secondary: var(--text-dim);
  --gantt-text-tertiary: var(--text-dim);
  --gantt-text-muted: var(--text-dim);
  --gantt-text-header: var(--text);
  --gantt-text-parent: var(--text);
  --gantt-text-placeholder: var(--text-dim);
  --gantt-text-disabled: var(--text-dim);
  --gantt-text-white: #ffffff;
  --gantt-text-on-primary: #ffffff;
  --gantt-border-light: var(--border);
  --gantt-border-color: var(--border);
  --gantt-border-base: var(--border);
  --gantt-border-medium: var(--border);
  --gantt-border-dark: var(--border);
  --gantt-border-hover: var(--text-dim);
  --gantt-border-disabled: var(--border);
  --gantt-primary: var(--accent);
  --gantt-primary-color: var(--accent);
  --gantt-primary-light: var(--accent-soft);
  --gantt-primary-lightest: var(--accent-soft);
  --gantt-primary-dark: var(--accent);
  --gantt-primary-hover: var(--accent);
  --gantt-success: var(--success);
  --gantt-warning: var(--warning);
  --gantt-warning-light: var(--warning-soft);
  --gantt-danger: var(--danger);
  --gantt-danger-light: var(--danger-soft);
  --gantt-danger-dark: var(--danger);
  --gantt-info: var(--accent);
  --gantt-off-leave: var(--merged);
  --gantt-off-leave-light: var(--merged-soft);
  --gantt-scrollbar-thumb: var(--border);
  --gantt-scrollbar-thumb-hover: var(--text-dim);
  --gantt-font-size-sm: var(--font-sm);
  --gantt-radius-sm: 6px;
  font-size: var(--font-md);
}

/* ---- 库内硬编码字号 → 本仓库五档 token（169 条库规则全在覆盖之前，产物实证）---- */
.gt-jordium .task-list {
  font-size: var(--font-md);
}
.gt-jordium .task-name,
.gt-jordium .expanded-title {
  font-size: var(--font-base);
}
.gt-jordium .task-bar-content,
.gt-jordium .task-title-above,
.gt-jordium .actual-task-name {
  font-size: var(--font-md);
}
.gt-jordium .task-progress,
.gt-jordium .actual-bar-content {
  font-size: var(--font-sm);
}
.gt-jordium .task-bar.overflow-effect .task-bar-content,
.gt-jordium .task-bar.overflow-effect .task-name {
  font-size: var(--font-md);
}
.gt-jordium .task-bar.overflow-effect .task-progress {
  font-size: var(--font-sm);
}
.gt-jordium .year-month-label,
.gt-jordium .month-label,
.gt-jordium .quarter-label,
.gt-jordium .half-year-label,
.gt-jordium .date-label,
.gt-jordium .year-label {
  font-size: var(--font-md);
}
.gt-jordium .day-label,
.gt-jordium .week-label,
.gt-jordium .hour-label {
  font-size: var(--font-sm);
}
.gt-jordium .milestone-label,
.gt-jordium .predecessor-tag {
  font-size: var(--font-sm);
}
.gt-jordium .gantt-btn,
.gt-jordium .gantt-btn-group-item {
  font-size: var(--font-md);
}
.gt-jordium .status-badge,
.gt-jordium .timer-badge {
  font-size: var(--font-xs);
}
.gt-jordium .avatar,
.gt-jordium .resource-avatar,
.gt-jordium .avatar .avatar-text {
  font-size: var(--font-xs);
}
.gt-jordium .tooltip-title,
.gt-jordium .hover-tooltip-title {
  font-size: var(--font-base);
}
.gt-jordium .hover-tooltip-label,
.gt-jordium .hover-tooltip-overflow-warning {
  font-size: var(--font-sm);
}
.gt-jordium .task-tooltip,
.gt-jordium .drag-tooltip,
.gt-jordium .drag-preview-content,
.gt-jordium .task-hover-tooltip,
.gt-jordium .anchor-tooltip,
.gt-jordium .milestone-sticky-tooltip {
  font-size: var(--font-md);
}
.gt-jordium .placeholder-text {
  font-size: var(--font-base);
}
.gt-jordium .placeholder-desc {
  font-size: var(--font-md);
}
.gt-jordium .conflict-header,
.gt-jordium .conflict-title,
.gt-jordium .total-overload,
.gt-jordium .conflict-task-name,
.gt-jordium .conflict-detail {
  font-size: var(--font-sm);
}
/* 依赖违规行（G4-a）：行名染警示色（barColor 已让条带警示边） */
.gt-jordium .gt-violation .task-name {
  color: var(--danger);
}
/* 深色模式：库的条色是「状态色混白」内联计算（95%/70% 白），深色画布上呈粉白块——
   只能 !important 覆盖（本仓库对内嵌组件的既有手法）。 */
:root[data-theme="dark"] .gt-jordium .task-bar {
  background-color: var(--bg-panel) !important;
  border-color: var(--border) !important;
  color: var(--text) !important;
}
:root[data-theme="dark"] .gt-jordium .task-bar.completed {
  background-color: var(--success-soft) !important;
  border-color: var(--success) !important;
}
:root[data-theme="dark"] .gt-jordium .task-bar.parent-task {
  background-color: var(--bg-chip) !important;
  border-color: var(--text-dim) !important;
}
.gt-jordium .task-bar.overflow-effect .task-name,
.gt-jordium .task-bar.overflow-effect .task-progress {
  color: var(--text-dim);
}
.gt-jordium .task-list-header,
.gt-jordium .task-list-header .col {
  font-weight: 600;
}
.gt-jordium .task-list-header .col {
  color: var(--text-dim);
}
.gt-jordium .task-list-header .col-name,
.gt-jordium .task-list-header .col-taskName {
  justify-content: flex-start;
}
.gt-jordium .day-column.today {
  background-color: color-mix(in srgb, var(--danger) 22%, transparent);
  opacity: 1;
  border-left-color: color-mix(in srgb, var(--danger) 45%, transparent);
}
.gt-jordium .day-column.today:before {
  background: none;
}
</style>
