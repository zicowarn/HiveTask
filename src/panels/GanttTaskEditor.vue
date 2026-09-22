<script setup lang="ts">
/**
 * 甘特任务编辑面板（应用风格；**字段集照甘特库的任务表单，控件全部换成应用组件**）：
 *   任务名称 / 负责人 / 预计起止 / 实际起止 / 预计·实际工时 / 进度 / 前置任务 / 描述。
 *
 * 不摆的字段（诚实边界）：库抽屉里的**任务类型 / 资源分配 / 上级任务**——我们的
 * 数据模型没有对应字段或写通道（《架构设计-甘特计划面》§7），画出来也存不下。
 *
 * 写操作**不在本组件**：表单只收集 + 校验，`save` 交给父面板执行——写路由
 * （容器/平台分流、依赖边 diff、字段值写穿透）集中在 GanttPanel 一处。
 */
import { computed, ref, watch } from "vue";
import type { ProjectItem, Resource } from "../api";
import type { TaskFormPayload } from "./gantt-model";
import { useI18n } from "../i18n";
import SideDrawer from "../components/SideDrawer.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import EditorIcon from "../components/EditorIcon.vue";

const props = defineProps<{
  open: boolean;
  item: ProjectItem | null;
  /** 面板工具条选定的字段映射（预计/实际起止、工时、进度）。 */
  mapping: {
    startFieldId: string | null;
    endFieldId: string | null;
    actualStartFieldId: string | null;
    actualEndFieldId: string | null;
    estHoursFieldId: string | null;
    actHoursFieldId: string | null;
    progressFieldId: string | null;
  };
  /** 资源目录（跨项目共享池；§5-bis）。 */
  resourceCatalog: Resource[];
  /** 当前分配（资源 id + 占用比例）。 */
  currentResources: { resourceId: string; allocation: number }[];
  /** 前置任务候选（已排除自身）。 */
  candidates: { id: string; label: string }[];
  /** 当前依赖条目 id。 */
  currentDeps: string[];
  /** 条目类型展示（Issue / PR / 草稿卡）。 */
  kindText: string;
  /** 上级任务初始值（本地真源优先、其次平台镜像）：null = 顶层。 */
  parentId: string | null;
}>();

const emit = defineEmits<{ close: []; save: [payload: TaskFormPayload]; remove: [] }>();
const { t } = useI18n();

const title = ref("");
const body = ref("");
const assignees = ref<string[]>([]);
const plannedStart = ref("");
const plannedEnd = ref("");
const actualStart = ref("");
const actualEnd = ref("");
const estHours = ref("");
const actualHours = ref("");
const progress = ref("");
const deps = ref<string[]>([]);
const parentDraft = ref<string | null>(null);
/** 资源分配行（照 jordium：资源 / 类别 / 占用比例；比例 clamp 20–100）。 */
const resourceRows = ref<{ resourceId: string; type: string; allocation: number }[]>([]);
/** ＋添加资源 的行内选择态。 */
const addingResource = ref(false);
const newResourceId = ref("");
const newResourceAllocation = ref(100);
const submitting = ref(false);
const error = ref<string | null>(null);

/** 字段值读成表单字符串（空串 = 未设置）。 */
function fieldValue(item: ProjectItem | null, fieldId: string | null): string {
  if (!item || !fieldId) return "";
  const raw = item.fieldValues[fieldId];
  if (!raw) return "";
  // 日期字段可能存 ISO：表单 input[type=date] 只认 YYYY-MM-DD
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : raw;
}

/** 打开/切换条目时装载表单。 */
watch(
  [() => props.open, () => props.item],
  ([open]) => {
    if (!open) return;
    const it = props.item;
    error.value = null;
    submitting.value = false;
    title.value = it ? (it.kind === "draft" ? (it.draftTitle ?? "") : (it.entity?.title ?? "")) : "";
    body.value = it ? (it.kind === "draft" ? (it.draftBody ?? "") : (it.entity?.title ? "" : "")) : "";
    assignees.value = [...(it?.entity?.assignees ?? [])];
    plannedStart.value = fieldValue(it, props.mapping.startFieldId);
    plannedEnd.value = fieldValue(it, props.mapping.endFieldId);
    actualStart.value = fieldValue(it, props.mapping.actualStartFieldId);
    actualEnd.value = fieldValue(it, props.mapping.actualEndFieldId);
    estHours.value = fieldValue(it, props.mapping.estHoursFieldId);
    actualHours.value = fieldValue(it, props.mapping.actHoursFieldId);
    progress.value = fieldValue(it, props.mapping.progressFieldId);
    deps.value = [...props.currentDeps];
    parentDraft.value = props.parentId;
    resourceRows.value = props.currentResources.map((r) => ({
      resourceId: r.resourceId,
      type: props.resourceCatalog.find((c) => c.id === r.resourceId)?.type ?? "Human",
      allocation: r.allocation,
    }));
    addingResource.value = false;
    newResourceId.value = "";
    newResourceAllocation.value = 100;
  },
  { immediate: true },
);

const kindLabelText = computed(() => {
  const it = props.item;
  if (!it) return "";
  if (it.kind === "draft") return t("gantt.kindDraft");
  if (it.kind === "pull") return `PR #${it.number ?? ""}`;
  return `#${it.number ?? ""}`;
});

/** 可选资源（排除已在行内的）。 */
const availableResources = computed(() =>
  props.resourceCatalog.filter((r) => !resourceRows.value.some((row) => row.resourceId === r.id)),
);

function resourceName(id: string): string {
  return props.resourceCatalog.find((r) => r.id === id)?.name ?? id;
}

function addResourceRow() {
  const id = newResourceId.value;
  if (!id) return;
  resourceRows.value.push({
    resourceId: id,
    type: props.resourceCatalog.find((r) => r.id === id)?.type ?? "Human",
    allocation: Math.min(100, Math.max(20, Math.round(newResourceAllocation.value) || 100)),
  });
  addingResource.value = false;
  newResourceId.value = "";
  newResourceAllocation.value = 100;
}

function removeResourceRow(id: string) {
  resourceRows.value = resourceRows.value.filter((r) => r.resourceId !== id);
}

const RESOURCE_TYPES = ["Human", "Device", "Others"];

/** 数值字段：空 = 不设置（null）；非数字/越界给错误。 */
function numOrNull(raw: string, label: string, min?: number, max?: number): number | null {
  const v = raw.trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(t("gantt.errNumber", { field: label }));
  if (min !== undefined && n < min) throw new Error(t("gantt.errNumber", { field: label }));
  if (max !== undefined && n > max) throw new Error(t("gantt.errNumber", { field: label }));
  return n;
}

function submit() {
  const name = title.value.trim();
  if (!name) {
    error.value = t("gantt.errTitleRequired");
    return;
  }
  try {
    const payload: TaskFormPayload = {
      title: name,
      body: body.value,
      assignees: assignees.value,
      plannedStart: plannedStart.value || null,
      plannedEnd: plannedEnd.value || null,
      actualStart: actualStart.value || null,
      actualEnd: actualEnd.value || null,
      estHours: numOrNull(estHours.value, t("gantt.estHours")),
      actualHours: numOrNull(actualHours.value, t("gantt.actHours")),
      progress: numOrNull(progress.value, t("gantt.progressField"), 0, 100),
      predecessorIds: [...deps.value],
      parentId: parentDraft.value,
      resources: resourceRows.value.map((r) => ({
        resourceId: r.resourceId,
        allocation: Math.min(100, Math.max(20, Math.round(r.allocation))),
      })),
    };
    if (payload.plannedStart && payload.plannedEnd && payload.plannedStart > payload.plannedEnd) {
      error.value = t("gantt.errDateOrder");
      return;
    }
    submitting.value = true;
    emit("save", payload);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** 保存完成后由父面板调用（成功关闭 / 失败留在面板显示错误）。 */
defineExpose({
  done: () => {
    submitting.value = false;
    emit("close");
  },
  fail: (message: string) => {
    submitting.value = false;
    error.value = message;
  },
});
</script>

<template>
  <SideDrawer
    :open="open"
    :title="t('gantt.editTask')"
    width="480px"
    top="44px"
    floating
    @close="emit('close')"
  >
    <div class="te">
      <div class="te-kind">{{ kindLabelText }}</div>

      <label class="te-field">
        <span class="te-label">{{ t("gantt.taskName") }} <i>*</i></span>
        <input v-model="title" class="te-input" :placeholder="t('gantt.taskName')" spellcheck="false" />
      </label>

      <!-- 任务类型：条目类型只读展示（我们的模型里类型即 issue/pull/draft，
           不是库的 task/milestone/story——没有可编辑语义就不摆假控件） -->
      <div class="te-field">
        <span class="te-label">{{ t("gantt.taskType") }}</span>
        <span class="te-readonly">{{ kindText }}</span>
      </div>

      <!-- 资源分配（§5-bis，照 jordium 参考实现）：行 = 资源 / 类别 / 占用比例
           （比例 clamp 20–100 与库同口径）；类别写回资源目录，比例写分配行 -->
      <div class="te-field">
        <div class="te-res-head">
          <span class="te-label">{{ t("gantt.resources") }}</span>
          <span class="te-res-col">{{ t("gantt.resourceName") }}</span>
          <span class="te-res-col">{{ t("gantt.resourceType") }}</span>
          <span class="te-res-col">{{ t("gantt.resourceAllocation") }}</span>
        </div>
        <div v-for="row in resourceRows" :key="row.resourceId" class="te-res-row">
          <span class="te-res-name">{{ resourceName(row.resourceId) }}</span>
          <DropdownMenu
            class="te-res-cell"
            :options="RESOURCE_TYPES.map((x) => ({ value: x, label: x }))"
            :model-value="row.type"
            @update:model-value="row.type = $event as string"
          />
          <input v-model.number="row.allocation" class="te-input te-res-cell" type="number" min="20" max="100" step="5" />
          <button class="te-icon-btn" :title="t('gantt.removeItem')" @click="removeResourceRow(row.resourceId)">
            <EditorIcon name="o.trash" />
          </button>
        </div>
        <div v-if="addingResource" class="te-res-row">
          <DropdownMenu
            class="te-res-name"
            :options="availableResources.map((r) => ({ value: r.id, label: r.name }))"
            :model-value="newResourceId"
            @update:model-value="newResourceId = $event as string"
          />
          <input v-model.number="newResourceAllocation" class="te-input te-res-cell" type="number" min="20" max="100" step="5" />
          <button class="te-icon-btn" :title="t('detail.save')" @click="addResourceRow">
            <EditorIcon name="o.check" />
          </button>
        </div>
        <button v-else class="te-add-res" @click="addingResource = true">
          ＋{{ t("gantt.addResource") }}
        </button>
      </div>

      <!-- 上级任务 = 结构扩展泳道（§3）：本地库真源（我们排的计划），
           平台 sub-issues 只作镜像回显 -->
      <label class="te-field">
        <span class="te-label">{{ t("gantt.parentTask") }}</span>
        <DropdownMenu
          class="te-dd"
          :options="[{ value: '', label: t('gantt.noParent') }, ...candidates.map((c) => ({ value: c.id, label: c.label }))]"
          :model-value="parentDraft ?? ''"
          @update:model-value="parentDraft = ($event as string) || null"
        />
      </label>

      <div class="te-grid">
        <label class="te-field">
          <span class="te-label">{{ t("gantt.plannedStart") }} <i>*</i></span>
          <input v-model="plannedStart" class="te-input" type="date" />
        </label>
        <label class="te-field">
          <span class="te-label">{{ t("gantt.plannedEnd") }} <i>*</i></span>
          <input v-model="plannedEnd" class="te-input" type="date" />
        </label>
        <label class="te-field">
          <span class="te-label">{{ t("gantt.actualStart") }}</span>
          <input v-model="actualStart" class="te-input" type="date" />
        </label>
        <label class="te-field">
          <span class="te-label">{{ t("gantt.actualEnd") }}</span>
          <input v-model="actualEnd" class="te-input" type="date" />
        </label>
        <label class="te-field">
          <span class="te-label">{{ t("gantt.estHours") }}</span>
          <input v-model="estHours" class="te-input" type="number" min="0" step="0.5" />
        </label>
        <label class="te-field">
          <span class="te-label">{{ t("gantt.actHours") }}</span>
          <input v-model="actualHours" class="te-input" type="number" min="0" step="0.5" />
        </label>
        <label class="te-field">
          <span class="te-label">{{ t("gantt.progressField") }}</span>
          <input v-model="progress" class="te-input" type="number" min="0" max="100" step="5" />
        </label>
        <label class="te-field">
          <span class="te-label">{{ t("gantt.predecessor") }}</span>
          <DropdownMenu
            class="te-dd"
            multiple
            checkbox
            :options="candidates.map((c) => ({ value: c.id, label: c.label }))"
            :model-value="deps"
            @update:model-value="deps = $event as string[]"
          />
        </label>
      </div>

      <label class="te-field">
        <span class="te-label">{{ t("gantt.description") }}</span>
        <textarea v-model="body" class="te-textarea" rows="4" spellcheck="false"></textarea>
      </label>

      <p v-if="error" class="te-error">{{ error }}</p>
    </div>

    <template #footer>
      <button class="te-btn danger" :disabled="submitting" @click="emit('remove')">
        {{ t("gantt.removeItem") }}
      </button>
      <span class="te-spacer"></span>
      <button class="te-btn" :disabled="submitting" @click="emit('close')">
        {{ t("conn.cancel") }}
      </button>
      <button class="te-btn primary" :disabled="submitting" @click="submit">
        {{ submitting ? t("common.syncing") : t("detail.save") }}
      </button>
    </template>
  </SideDrawer>
</template>

<style scoped>
.te {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.te-kind {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.te-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.te-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.te-label {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.te-label i {
  color: var(--danger);
  font-style: normal;
}
.te-input,
.te-textarea {
  display: block;
  width: 100%;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  outline: none;
  box-sizing: border-box;
}
.te-textarea {
  height: auto;
  padding: 6px 8px;
  font-family: inherit;
  line-height: 1.5;
  resize: vertical;
}
.te-input:focus,
.te-textarea:focus {
  border-color: var(--accent);
}
/* 原生日期控件的日历图标在暗色下几乎不可见（平台同款处理：反色滤镜） */
.te-input[type="date"]::-webkit-calendar-picker-indicator {
  filter: var(--cal-filter, none);
  cursor: pointer;
}
.te-dd {
  width: 100%;
}
.te-dd :deep(.dd-trigger) {
  width: 100%;
  justify-content: space-between;
}
.te-hint {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 只读字段（有值显示值、无值显示「无」——不摆灰input假控件） */
/* 资源分配（照库的行式布局，控件换应用件） */
.te-res-head,
.te-res-row {
  display: grid;
  grid-template-columns: 1.4fr 1fr 84px 24px;
  gap: 6px;
  align-items: center;
}
.te-res-head {
  margin-bottom: 4px;
}
.te-res-col {
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.te-res-name {
  font-size: var(--font-md);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.te-res-row {
  margin-bottom: 6px;
}
.te-res-cell {
  min-width: 0;
}
.te-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text-dim);
  cursor: pointer;
}
.te-icon-btn:hover {
  color: var(--danger);
  border-color: var(--danger);
}
.te-add-res {
  height: 24px;
  border: 1px dashed var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--accent);
  font-size: var(--font-md);
  cursor: pointer;
}
.te-add-res:hover {
  border-color: var(--accent);
}
.te-readonly {
  display: flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-chip);
  color: var(--text-dim);
  font-size: var(--font-md);
}
.te-error {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--danger);
}
.te-btn {
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  cursor: pointer;
}
.te-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.te-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.te-btn.danger {
  color: var(--danger);
}
.te-spacer {
  flex: 1;
}
</style>
