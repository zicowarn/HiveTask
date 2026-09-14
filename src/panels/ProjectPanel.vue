<script setup lang="ts">
/**
 * Projects panel — the P4 board workspace (registered as "project.board").
 * 顶部一行 = 筛选条 + ⚙ 视图（项目的选择/新建/改名/删除全部在头部
 * 「切换项目」对话框 ProjectManager）。模式组件渲染选中项目的条目，
 * 应用级：不随仓库切换。
 */
import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import { resolvePanel } from "../workbench/registry";
import { useProjectsStore } from "../stores/projects";
import { useI18n } from "../i18n";

defineProps<{ leafId?: string; panelType?: string }>();

const PANEL_TYPE = "project.board";
const MODE_STORAGE_KEY = "hivetask.panel-mode.project.board";

const def = resolvePanel(PANEL_TYPE);
const modes = def.modes ?? [];

const store = useProjectsStore();
const { t } = useI18n();
const { projects, loading, error, filterText } = storeToRefs(store);
const { setSortBy } = store;

const storedMode =
  modes.find((m) => m.key === localStorage.getItem(MODE_STORAGE_KEY))?.key ?? modes[0]?.key;
const modeKey = ref(storedMode);
const activeMode = computed(() => modes.find((m) => m.key === modeKey.value) ?? modes[0]);

onMounted(() => {
  void store.loadAll();
});

// ---- 视图工具栏（对齐 GitHub Projects：左筛选 chips + ⚙ View 面板）----
const viewOpen = ref(false);
type ViewSub = null | "sort";
const viewSub = ref<ViewSub>(null);
const displayModes = computed(() =>
  [...modes].sort((a, b) => (a.key === "table" ? -1 : 1) - (b.key === "table" ? -1 : 1)),
);
const sortOptions = computed(() => [
  { value: "manual" as const, label: t("project.sortManual") },
  { value: "priority" as const, label: t("project.sortPriority") },
  { value: "added" as const, label: t("project.sortAdded") },
]);
const sortLabel = computed(
  () => sortOptions.value.find((o) => o.value === store.sortBy)?.label ?? "",
);
function toggleView() {
  viewOpen.value = !viewOpen.value;
  viewSub.value = null;
}
function pickSort(v: "manual" | "priority" | "added") {
  setSortBy(v);
  viewSub.value = null;
}
/** 已识别的 status:/priority: token 渲染成 chips；× 删除该 token。 */
const filterChips = computed(() => {
  const statusNames = store.statusField?.options.map((o) => o.name) ?? [];
  const priorityNames = store.priorityField?.options.map((o) => o.name) ?? [];
  const chips: { kind: "status" | "priority"; value: string }[] = [];
  for (const part of filterText.value.split(/\s+/).filter(Boolean)) {
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
  filterText.value = filterText.value
    .split(/\s+/)
    .filter((p) => p.toLowerCase() !== token.toLowerCase())
    .join(" ")
    .trim();
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <p v-if="error" class="pj-error">{{ error }}</p>

    <div v-if="projects.length === 0 && !loading" class="pj-empty">
      {{ t("project.empty") }}
    </div>

    <div v-else class="pj-body">
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
            v-model="filterText"
            class="filter-input"
            :placeholder="t('project.filterPlaceholder')"
            spellcheck="false"
          />
        </div>
        <div class="view-menu-wrap">
          <button class="view-btn" :class="{ open: viewOpen }" @click="toggleView">
            <svg class="view-gear" viewBox="0 0 16 16" style="width: var(--icon-size, 14px); height: var(--icon-size, 14px)" fill="currentColor" aria-hidden="true">
              <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073.159-.059.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113-.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 1 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"/>
            </svg>
            {{ t("mode.view") }}
          </button>
          <div v-if="viewOpen" class="view-pop">
            <div class="view-layout-seg">
              <button
                v-for="m in displayModes"
                :key="m.key"
                class="view-seg-btn"
                :class="{ active: modeKey === m.key }"
                @click="modeKey = m.key"
              >
                <span class="view-seg-icon">{{ m.key === "board" ? "▤" : "▦" }}</span>
                {{ t(m.labelKey) }}
              </button>
            </div>
            <template v-if="viewSub === null">
              <button class="view-row" @click="viewSub = 'sort'">
                <span class="view-row-icon">⇅</span>
                <span class="view-row-label">{{ t("project.viewSort") }}</span>
                <span class="view-row-value">{{ sortLabel }}</span>
                <span class="view-row-chev">›</span>
              </button>
              <div class="view-row static">
                <span class="view-row-icon">▥</span>
                <span class="view-row-label">{{ t("project.viewColumnBy") }}</span>
                <span class="view-row-value">{{ t("project.colStatus") }}</span>
              </div>
            </template>
            <template v-else-if="viewSub === 'sort'">
              <button class="view-row back" @click="viewSub = null">
                <span class="view-row-chev back">‹</span>
                <span class="view-row-label">{{ t("project.viewSort") }}</span>
              </button>
              <button
                v-for="opt in sortOptions"
                :key="opt.value"
                class="view-row"
                @click="pickSort(opt.value)"
              >
                <span class="view-row-icon check">{{ store.sortBy === opt.value ? "✓" : "" }}</span>
                <span class="view-row-label">{{ opt.label }}</span>
              </button>
            </template>
          </div>
        </div>
      </div>

      <div class="pj-view">
        <component :is="activeMode.component" />
      </div>
    </div>
  </PanelShell>
</template>

<style scoped>
.pj-error {
  margin: 8px 14px 0;
  padding: 8px 10px;
  font-size: 12px;
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
  font-size: 12px;
}
.pj-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
/* 顶栏：筛选条 + ⚙视图（项目选择在头部切换对话框） */
.pj-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px 6px;
  border-bottom: 1px solid var(--border);
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
  font-size: 11px;
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
  font-size: 12px;
  cursor: pointer;
  padding: 0 2px;
}
.filter-input {
  flex: 1;
  min-width: 120px;
  border: none;
  outline: none;
  background: transparent;
  font-size: 12px;
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
  font-size: 12px;
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
.view-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 30;
  width: 340px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.view-layout-seg {
  display: flex;
  gap: 8px;
  margin-bottom: 6px;
}
.view-seg-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-dim);
  font-size: 12px;
  padding: 6px 0;
  border-radius: 8px;
  cursor: pointer;
}
.view-seg-btn:hover {
  color: var(--text);
}
.view-seg-btn.active {
  border-color: var(--text);
  color: var(--text);
  font-weight: 600;
}
.view-seg-icon {
  font-size: 12px;
  line-height: 1;
}
.view-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.view-row:hover {
  background: var(--bg-hover);
}
.view-row.static {
  cursor: default;
}
.view-row.static:hover {
  background: transparent;
}
.view-row.back {
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
  border-radius: 6px 6px 0 0;
  margin-bottom: 2px;
}
.view-row-icon {
  width: 18px;
  flex: none;
  text-align: center;
  color: var(--text-dim);
}
.view-row-icon.check {
  color: var(--accent);
  font-weight: 700;
}
.view-row-label {
  flex: 1;
}
.view-row-value {
  color: var(--text);
}
.view-row-chev {
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
}
.view-row-chev.back {
  margin-right: 2px;
}
</style>
