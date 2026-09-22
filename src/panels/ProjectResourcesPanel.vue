<script setup lang="ts">
/**
 * 资源目录 Editor（「项目」工作区分组）——甘特负责人 / 设备的维护面。
 *
 * 从设置面板搬出来（用户定案 2026-09-22）：资源是**项目域的数据**（随设备包走、
 * 跨项目共享），不是应用偏好；与语言/主题/打开方式那类「这台机器的设置」不同类，
 * 摆在设置里语义不对，也挤。
 *
 * 资源目录本体在 projects store（`resourceCatalog`）：项目数据装载时自动拉一次，
 * 甘特的资源分配下拉读同一份；本面板只管增删改与来源标注。
 */
import { onMounted, ref } from "vue";
import PanelShell from "../workbench/PanelShell.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import { isTauri, type Resource } from "../api";
import { useI18n } from "../i18n";
import { useProjectsStore } from "../stores/projects";

defineProps<{ leafId?: string; panelType?: string }>();

const { t } = useI18n();
const projects = useProjectsStore();

/** 资源类别（照 jordium 预设：Human / Device / Others；允许自定义，这里给三档常用）。 */
const RESOURCE_TYPES = ["Human", "Device", "Others"];

const draft = ref<{ name: string; type: string } | null>(null);
/** 两击确认删除（沿用本仓库删除类动作的惯例）。 */
const armedId = ref<string | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);

onMounted(() => void load());

async function load(): Promise<void> {
  if (!isTauri()) return;
  loading.value = true;
  try {
    await projects.loadResources();
  } finally {
    loading.value = false;
  }
}

function addDraft(): void {
  error.value = null;
  draft.value = { name: "", type: "Human" };
}

async function commitDraft(): Promise<void> {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    draft.value = null;
    return;
  }
  try {
    await projects.upsertResource({
      id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      type: d.type,
      origin: null,
    } as Resource);
    draft.value = null;
  } catch (e) {
    error.value = String(e);
  }
}

/** 行内改字段（名称/职务/日容量）：失焦或回车即保存。 */
async function patchResource(r: Resource, patch: Partial<Resource>): Promise<void> {
  try {
    await projects.upsertResource({ ...r, ...patch });
  } catch (e) {
    error.value = String(e);
  }
}

async function removeResource(r: Resource): Promise<void> {
  if (armedId.value !== r.id) {
    armedId.value = r.id;
    return;
  }
  armedId.value = null;
  try {
    await projects.removeResource(r.id);
  } catch (e) {
    error.value = String(e);
  }
}

function originLabel(r: Resource): string {
  return r.origin ? t("resource.fromPlatform", { origin: r.origin }) : t("resource.fromLocal");
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template #actions>
      <button class="rc-add" @click="addDraft">{{ t("resource.add") }}</button>
    </template>

    <div class="rc-wrap">
      <p class="rc-hint">{{ t("resource.hint") }}</p>

      <div class="rc-head">
        <span class="rc-name">{{ t("resource.colName") }}</span>
        <span class="rc-type">{{ t("resource.colType") }}</span>
        <span class="rc-title">{{ t("resource.colTitle") }}</span>
        <span class="rc-cap">{{ t("resource.colCapacity") }}</span>
        <span class="rc-origin">{{ t("resource.colOrigin") }}</span>
        <span class="rc-act"></span>
      </div>

      <p v-if="projects.resourceCatalog.length === 0 && !draft" class="rc-empty">
        {{ loading ? t("common.loading") : t("resource.empty") }}
      </p>

      <div v-for="r in projects.resourceCatalog" :key="r.id" class="rc-row">
        <input
          class="rc-name"
          :value="r.name"
          spellcheck="false"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
          @blur="patchResource(r, { name: ($event.target as HTMLInputElement).value.trim() || r.name })"
        />
        <DropdownMenu
          class="rc-type"
          :options="RESOURCE_TYPES.map((x) => ({ value: x, label: x }))"
          :model-value="r.type"
          @update:model-value="patchResource(r, { type: $event as string })"
        />
        <input
          class="rc-title"
          :value="r.title ?? ''"
          :placeholder="t('resource.titlePh')"
          spellcheck="false"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
          @blur="patchResource(r, { title: ($event.target as HTMLInputElement).value.trim() || null })"
        />
        <input
          class="rc-cap"
          type="number"
          min="0"
          step="0.5"
          :value="r.capacity ?? ''"
          :placeholder="t('resource.capacityPh')"
          @keydown.enter="($event.target as HTMLInputElement).blur()"
          @blur="
            patchResource(r, {
              capacity:
                ($event.target as HTMLInputElement).value === ''
                  ? null
                  : Number(($event.target as HTMLInputElement).value),
            })
          "
        />
        <span class="rc-origin" :title="originLabel(r)">{{ originLabel(r) }}</span>
        <span class="rc-act">
          <button class="rc-remove" :class="{ armed: armedId === r.id }" @click="removeResource(r)">
            {{ armedId === r.id ? t("resource.removeArm") : t("resource.remove") }}
          </button>
        </span>
      </div>

      <div v-if="draft" class="rc-row">
        <input
          v-model="draft.name"
          class="rc-name"
          :placeholder="t('resource.namePh')"
          spellcheck="false"
          @keydown.enter="commitDraft"
          @blur="commitDraft"
        />
        <DropdownMenu
          class="rc-type"
          :options="RESOURCE_TYPES.map((x) => ({ value: x, label: x }))"
          :model-value="draft.type"
          @update:model-value="draft!.type = $event as string"
        />
        <span class="rc-rest">{{ t("resource.draftHint") }}</span>
      </div>

      <p v-if="error" class="rc-error">{{ error }}</p>
    </div>
  </PanelShell>
</template>

<style scoped>
.rc-wrap {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px 20px;
}
.rc-add {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  height: 22px;
  padding: 0 10px;
  border-radius: 6px;
  cursor: pointer;
}
.rc-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.rc-hint {
  margin: 0 0 10px;
  font-size: var(--font-sm);
  color: var(--text-dim);
  line-height: 1.5;
}
.rc-head,
.rc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
}
.rc-head {
  border-bottom: 1px solid var(--border);
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.rc-row {
  border-bottom: 1px solid var(--border);
}
/* 列宽：名称最宽、类别与容量固定、来源与动作贴右（表头与数据行共用同一组类名） */
.rc-name {
  flex: 1 1 auto;
  min-width: 120px;
}
.rc-type {
  flex: 0 0 104px;
}
.rc-title {
  flex: 0 0 160px;
  min-width: 0;
}
.rc-cap {
  flex: 0 0 104px;
}
.rc-origin {
  flex: 0 0 110px;
  font-size: var(--font-xs);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rc-act {
  flex: 0 0 62px;
  display: flex;
  justify-content: flex-end;
}
.rc-rest {
  flex: 1 1 auto;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
input.rc-name,
input.rc-title,
input.rc-cap {
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  outline: none;
}
input.rc-name:focus,
input.rc-title:focus,
input.rc-cap:focus {
  border-color: var(--accent);
}
.rc-remove {
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  cursor: pointer;
}
.rc-remove:hover {
  border-color: var(--danger);
  color: var(--danger);
}
.rc-remove.armed {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
.rc-empty {
  margin: 10px 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.rc-error {
  margin: 10px 0 0;
  font-size: var(--font-sm);
  color: var(--danger);
}
</style>
