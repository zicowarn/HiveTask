<script setup lang="ts">
/**
 * Projects panel — the P4 board workspace (registered as "project.board").
 * 顶部一行 = 筛选条 + ⚙ 视图（项目的选择/新建/改名/删除全部在头部
 * 「切换项目」对话框 ProjectManager）。模式组件渲染选中项目的条目，
 * 应用级：不随仓库切换。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import EditorIcon from "../components/EditorIcon.vue";
import ActionMenu, { type ActionItem } from "../components/ActionMenu.vue";
import ProjectViewSettings from "./ProjectViewSettings.vue";
import TeamSlicePanel from "./TeamSlicePanel.vue";
import ProjectItemDrawer from "./ProjectItemDrawer.vue";
import ProjectUnlinkedHint from "./ProjectUnlinkedHint.vue";
import type { ProjectItem } from "../api";
import { resolvePanel } from "../workbench/registry";
import { useProjectsStore } from "../stores/projects";
import { useI18n } from "../i18n";
import { api } from "../api";
import { reportError, translateError } from "../gh-errors";
import { pushToast } from "../toast";

defineProps<{ leafId?: string; panelType?: string }>();

const PANEL_TYPE = "project.board";

const def = resolvePanel(PANEL_TYPE);
const modes = def.modes ?? [];

const store = useProjectsStore();
const { t } = useI18n();
const { projects, loading, error, publishError } = storeToRefs(store);

// 视图页签（对齐平台）：页签 = 视图，布局是视图属性（View 弹层的 Layout 分段切换）。
const activeMode = computed(() => modes.find((m) => m.key === store.layout) ?? modes[0]);

/** 导出**当前项目**为设备包（单项目 = 数组长度 1 的同一个格式；《导出与导入》§设备包）。 */
const exporting = ref(false);
async function exportProject(): Promise<void> {
  const project = store.selected;
  if (!project || exporting.value) return;
  exporting.value = true;
  try {
    const json = await api.exportPack([project.id]);
    const name = `${project.displayName || "project"}.export`.replace(/[/\\]/g, "-");
    const saved = await api.saveTextFile(name, json);
    if (saved) pushToast({ kind: "success", message: t("transfer.exported", { path: saved }) });
  } catch (e) {
    pushToast({ kind: "error", message: translateError(String(e)) });
  } finally {
    exporting.value = false;
  }
}

/** 新建视图：平台该按钮是 ActionMenu（已取证 haspopup=true）——先选布局再建。 */
const newViewItems = computed(() => [
  ...modes.map((m) => ({
    value: m.key,
    label: t(m.labelKey),
    group: t("project.newViewGroup"),
    icon:
      m.key === "table" ? "o.layout-table" : m.key === "roadmap" ? "o.layout-roadmap" : "o.layout-board",
  })),
  // 平台：Layout 段之后分隔线 + Duplicate view（复制当前视图）
  { value: "__duplicate__", label: t("project.viewDuplicate"), group: "", icon: "o.copy" },
]);
function onNewViewPick(key: string) {
  if (key === "__duplicate__") return store.duplicateView(store.activeViewId);
  store.addView(key as never);
}
/** 选中视图的选项菜单（平台 View options）：重命名 / 左移 / 右移 / 复制 / 删除。 */
/** 视图选项菜单（平台形态：平铺 + 行首图标 + 尾部分隔线 + 导出）。 */
function viewMenuItems(id: string) {
  const idx = store.views.findIndex((v) => v.id === id);
  const items: ActionItem[] = [
    { value: "rename", label: t("project.viewRename"), icon: "o.edit" },
    { value: "duplicate", label: t("project.viewDuplicate"), icon: "o.copy" },
    { value: "delete", label: t("project.actDelete"), danger: true, icon: "o.trash" },
  ];
  // 位置：非首尾才给移动（平台是单个 Move view，我们按可移动方向展开——③标注）
  if (idx > 0) items.splice(1, 0, { value: "left", label: t("project.actMoveLeft"), icon: "o.grabber" });
  if (idx >= 0 && idx < store.views.length - 1) {
    items.splice(items.findIndex((i) => i.value === "left") >= 0 ? 2 : 1, 0, {
      value: "right",
      label: t("project.actMoveRight"),
      icon: "o.grabber",
    });
  }
  // 分隔线 + 导出视图数据（group 空串 = 只画分隔线）
  items.push({ value: "export", label: t("project.viewExportData"), group: "", icon: "o.download" });
  return items;
}

/** 导出当前视图数据为 CSV（平台 Export view data；列 = 视图显示字段）。 */
async function exportViewData() {
  const cols = store.fieldCatalogue.filter((f) => store.view.fields.includes(f.id as never));
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    ["Title", ...cols.filter((c) => c.id !== "title").map((c) => c.name)].map(esc).join(","),
  ];
  for (const item of store.filteredItems) {
    const row = [store.cellOf("title", item)?.text ?? ""];
    for (const col of cols) {
      if (col.id === "title") continue;
      row.push(store.cellOf(col.id, item)?.text ?? "");
    }
    lines.push(row.map(esc).join(","));
  }
  const name = `${store.activeView?.name ?? "view"}.csv`;
  try {
    await api.saveTextFile(name, "﻿" + lines.join("\n"));
  } catch (e) {
    reportError(String(e));
  }
}
const renamingView = ref<string | null>(null);
const renameViewName = ref("");
function onViewMenuPick(id: string, value: string) {
  if (value === "rename") {
    renamingView.value = id;
    renameViewName.value = store.views.find((v) => v.id === id)?.name ?? "";
    return;
  }
  if (value === "left") return store.moveView(id, -1);
  if (value === "right") return store.moveView(id, 1);
  if (value === "duplicate") return store.duplicateView(id);
  if (value === "delete" && confirm(t("project.viewDeleteConfirm"))) store.deleteView(id);
  if (value === "export") void exportViewData();
}
function submitViewRename() {
  if (renamingView.value) store.renameView(renamingView.value, renameViewName.value);
  renamingView.value = null;
}

onMounted(() => {
  void store.loadAll();
});

// ---- 项目数据刷新（面板头部：视图页签右侧、布局三按钮左侧）----
const syncing = ref(false);
const syncNote = ref("");
/** 拉线上 Projects 条目落本地看板（仅绑定线上的项目；未绑定/跳过会在提示里说明）。 */
async function refreshProjectData() {
  if (syncing.value) return;
  syncing.value = true;
  syncNote.value = "";
  try {
    const result = await store.syncSelected();
    if (result) {
      const [imported, skipped] = result;
      syncNote.value = t("project.syncDone", { n: String(imported), s: String(skipped) });
      setTimeout(() => (syncNote.value = ""), 4000);
    }
  } finally {
    syncing.value = false;
  }
}

// ---- ⚙ 视图设置（内容见 ProjectViewSettings.vue）----
// 外点 / Esc 关闭：监听挂在整块 wrapper 上（含触发器）——若由弹层自己监听，
// 捕获阶段先关、按钮再开会让「点按钮关闭」失效。
const viewOpen = ref(false);
const viewMenuEl = ref<HTMLElement | null>(null);
function toggleView() {
  viewOpen.value = !viewOpen.value;
}
function onDocPointerDown(event: MouseEvent) {
  if (!viewOpen.value) return;
  if (viewMenuEl.value && !viewMenuEl.value.contains(event.target as Node)) viewOpen.value = false;
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") viewOpen.value = false;
}
onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onKeydown);
});
/** 已识别的 status:/priority: token 渲染成 chips；× 删除该 token。 */
const filterChips = computed(() => {
  const statusNames = store.statusField?.options.map((o) => o.name) ?? [];
  const priorityNames = store.priorityField?.options.map((o) => o.name) ?? [];
  const chips: { kind: "status" | "priority"; value: string }[] = [];
  for (const part of store.view.filter.split(/\s+/).filter(Boolean)) {
    const m = part.match(/^(status|priority):(.+)$/i);
    if (!m) continue;
    const kind = (m[1]!.toLowerCase() === "status" ? "status" : "priority") as "status" | "priority";
    const pool = kind === "status" ? statusNames : priorityNames;
    const needle = m[2]!.replace(/^"|"$/g, "");
    if (pool.some((n) => n.toLowerCase().includes(needle.toLowerCase()))) {
      chips.push({ kind, value: m[2]! });
    }
  }
  return chips;
});
function removeChip(chip: { kind: string; value: string }) {
  const token = `${chip.kind}:${chip.value}`;
  store.view.filter = store.view.filter
    .split(/\s+/)
    .filter((p) => p.toLowerCase() !== token.toLowerCase())
    .join(" ")
    .trim();
}

/** item 抽屉的「在 Issues 中打开」= 切仓库上下文 + 打开详情（原整卡点击行为）。 */
function openItemInWorkspace(item: ProjectItem) {
  store.closePanelItem();
  if (!item.repoId || !item.number) return;
  store.navRequest = { workspace: "issues", repoId: item.repoId, number: item.number };
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template #actions>
      <span v-if="syncNote" class="sync-note">{{ syncNote }}</span>
      <button
        class="refresh-btn"
        :disabled="!store.selected || exporting"
        :title="t('project.exportHint')"
        @click="exportProject"
      >{{ exporting ? t("common.syncing") : t("project.export") }}</button>
      <button
        class="refresh-btn"
        :disabled="syncing || !store.selected"
        :title="t('project.refreshData')"
        @click="refreshProjectData"
      >{{ syncing ? t("common.syncing") : t("common.refresh") }}</button>
    </template>
    <template #switcher>
      <div class="view-tabs">
        <div
          v-for="v in store.views"
          :key="v.id"
          class="view-tab-wrap"
          :class="{ active: v.id === store.activeViewId }"
        >
          <input
            v-if="renamingView === v.id"
            v-model="renameViewName"
            class="view-tab-input"
            @keydown.enter="submitViewRename"
            @keydown.escape="renamingView = null"
            @blur="submitViewRename"
          />
          <button
            v-else
            class="view-tab"
            :class="{ active: v.id === store.activeViewId }"
            @click="store.setActiveView(v.id)"
          >{{ v.name }}</button>
          <!-- 选中 tab 的选项菜单（平台：View options ▾） -->
          <ActionMenu
            v-if="v.id === store.activeViewId && renamingView !== v.id"
            class="view-tab-caret"
            trigger-icon="o.chevron-down"
            :title="t('project.viewOptions')"
            :items="viewMenuItems(v.id)"
            @pick="onViewMenuPick(v.id, $event)"
          />
        </div>
        <!-- 新建视图：平台为 ActionMenu（选布局后建） -->
        <ActionMenu
          class="view-tab-new-dd"
          :items="newViewItems"
          :title="t('project.newView')"
          @pick="onNewViewPick"
        >
          <template #trigger="{ toggle, open }">
            <button class="view-tab-new" type="button" :class="{ on: open }" @click="toggle">
              <EditorIcon name="o.plus" />
              {{ t("project.newView") }}
            </button>
          </template>
        </ActionMenu>
      </div>
    </template>
    <p v-if="error" class="pj-error">{{ error }}</p>
    <p v-else-if="publishError" class="pj-error">{{ publishError }}</p>

    <div v-if="projects.length === 0 && !loading" class="pj-empty">
      {{ t("project.empty") }}
    </div>

    <div v-else class="pj-body">
      <!-- Team items 切片左导航（平台 Slicer，2026-09 取证 views/3：265px 白底、
           头部 34px 灰底切换钮、值行 48px + 20px 头像 + 计数胶囊 + 行首 ✓）。
           不切片（No slicing）时整个收起，主区恢复全量 -->
      <aside v-if="store.sliceActive" class="team-nav">
        <TeamSlicePanel />
      </aside>
      <div class="pj-main">
      <div class="pj-topbar">
        <div class="filter-box">
          <svg class="filter-icon" viewBox="0 0 16 16" style="width: var(--icon-size, 14px); height: var(--icon-size, 14px)" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <span
            v-for="chip in filterChips"
            :key="`${chip.kind}:${chip.value}`"
            class="filter-chip"
          >
            <span class="filter-chip-kind">{{ chip.kind === "status" ? t("project.colStatus") : t("project.colPriority") }}</span>
            {{ chip.value }}
            <button class="filter-chip-x" @click="removeChip(chip)">×</button>
          </span>
          <input
            v-model="store.view.filter"
            class="filter-input"
            :placeholder="t('project.filterPlaceholder')"
            spellcheck="false"
          />
        </div>
        <div ref="viewMenuEl" class="view-menu-wrap">
          <button class="view-btn" :class="{ open: viewOpen }" @click="toggleView">
            <svg class="view-gear" viewBox="0 0 16 16" style="width: var(--icon-size, 14px); height: var(--icon-size, 14px)" fill="currentColor" aria-hidden="true">
              <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073.159-.059.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113-.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 1 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"/>
            </svg>
            {{ t("project.viewSettings") }}
          </button>
          <ProjectViewSettings v-if="viewOpen" :layout="store.layout" />
        </div>
      </div>

      <!-- 未关联提示条（自持 store 的小组件；三个视图共用——未关联与视图无关） -->
      <ProjectUnlinkedHint />

      <div class="pj-view">
        <component :is="activeMode.component" />
      </div>
      </div>
    </div>

    <!-- Item 详情抽屉（Board / Table 共用；标题 / 状态 / 描述 / 项目字段） -->
    <ProjectItemDrawer
      :open="!!store.panelItem"
      :item="store.panelItem"
      @close="store.closePanelItem()"
      @open="openItemInWorkspace"
    />
  </PanelShell>
</template>

<style scoped>
/* 视图页签行（照平台形态：37px 页签、激活态白底 + 顶部圆角；新建 32px 灰字） */
.view-tabs {
  display: flex;
  align-items: flex-end;
  gap: 2px;
}
/* 视图页签（选中态：白底 + 顶圆角；选中页签右侧带 ▾ 选项菜单） */
.view-tab-wrap {
  display: inline-flex;
  align-items: center;
  border-radius: 6px 6px 0 0;
}
.view-tab-wrap.active {
  background: var(--bg-panel);
  box-shadow: inset 0 1px 0 var(--border), inset 1px 0 0 var(--border), inset -1px 0 0 var(--border);
}
.view-tab-wrap.active .view-tab {
  font-weight: 600;
}
.view-tab-caret {
  margin-right: 2px;
}
.view-tab-input {
  width: 120px;
  height: 24px;
  margin: 0 6px;
  font-size: var(--font-base);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--accent);
  border-radius: 5px;
  padding: 0 6px;
  outline: none;
}
.view-tab-new-dd :deep(.am-trigger) {
  padding: 0;
}
.view-tab {
  height: 30px;
  padding: 0 12px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-base);
  border-radius: 6px 6px 0 0;
  cursor: pointer;
}
.view-tab:hover {
  background: var(--bg-hover);
}
.view-tab.active {
  font-weight: 600;
}
.view-tab-new {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 10px;
  margin-left: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-base);
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
}
.view-tab-new:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.refresh-btn {
  height: 22px;
  padding: 0 12px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.refresh-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.refresh-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.sync-note {
  font-size: var(--font-sm);
  color: var(--text-dim);
  white-space: nowrap;
}
.pj-error {
  margin: 8px 14px 0;
  padding: 8px 10px;
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
}
.pj-empty {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--text-dim);
  font-size: var(--font-md);
}
.pj-body {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
}
/* 主列：切片不启用时是 body 唯一子级（渲染与改造前一致） */
.pj-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
/* Team items 左导航（平台 SlicerPanel 实测：265px 白底、无右边框——
   与主区的分界靠主区自身留白；值行间 inset 分隔线由行 border 提供） */
.team-nav {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 265px;
  min-height: 0;
  background: var(--bg-panel);
  border-right: 1px solid var(--border);
}
/* 导航主体（顶行字段切换 + Deselect、带描述的值列表、底部空值开关）
   全部在 TeamSlicePanel.vue 内实现 */
/* 顶栏：筛选条 + ⚙视图（项目选择在头部切换对话框）。
   筛选框上下间隙对称（8/8）；其下边框即为与下方视图的分界线，视图侧不再画顶线 */
.pj-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 8px;
  border-bottom: none;
}
.pj-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
/* 视图工具栏：整行（筛选条弹性 + ⚙ View） */
.view-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  position: relative;
}
.filter-box {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  flex: 1;
  min-height: 30px;
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
}
.filter-icon {
  color: var(--text-dim);
  flex: none;
}
.filter-box:focus-within {
  border-color: var(--accent);
}
.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: var(--font-sm);
  padding: 1px 4px 1px 7px;
  border-radius: 4px;
  background: var(--bg-selected);
  color: var(--accent);
}
.filter-chip-kind {
  font-weight: 600;
}
.filter-chip-x {
  border: none;
  background: transparent;
  color: inherit;
  font-size: var(--font-md);
  cursor: pointer;
  padding: 0 2px;
}
.filter-input {
  flex: 1;
  min-width: 120px;
  border: none;
  outline: none;
  background: transparent;
  font-size: var(--font-md);
  font-family: inherit;
  color: var(--text);
}
.filter-input::placeholder {
  color: var(--text-dim);
}
.view-menu-wrap {
  position: relative;
  flex: none;
}
.view-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}
.view-gear {
  color: var(--text-dim);
}
.view-btn:hover .view-gear,
.view-btn.open .view-gear {
  color: var(--accent);
}
.view-btn:hover,
.view-btn.open {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
