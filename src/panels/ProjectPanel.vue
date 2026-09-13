<script setup lang="ts">
/**
 * Projects panel — the P4 board workspace (registered as "project.board").
 * Chrome hosts the project tab strip (select/rename/delete); creation lives
 * in the header's 切换项目 dialog (ProjectManager, mirroring the repo side).
 * The mode components render the selected project's items from the projects
 * store. Application-level: nothing here follows repository switches.
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
const { projects, selectedId, loading, error, filterText } = storeToRefs(store);
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

// ---- 重命名 ----
const renaming = ref<string | null>(null);
const renameName = ref("");
async function submitRename() {
  if (!renaming.value || !renameName.value.trim()) return;
  await store.rename(renaming.value, renameName.value);
  renaming.value = null;
}

// ---- 删除（两击确认） ----
const confirmingDelete = ref<string | null>(null);
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <p v-if="error" class="pj-error">{{ error }}</p>

    <div v-if="projects.length === 0 && !loading" class="pj-empty">
      {{ t("project.empty") }}
    </div>

    <div v-else class="pj-body">
      <ul class="pj-list">
        <li
          v-for="p in projects"
          :key="p.id"
          class="pj-item"
          :class="{ active: p.id === selectedId }"
          @click="store.select(p.id)"
        >
          <template v-if="renaming === p.id">
            <input
              v-model="renameName"
              class="pj-input"
              @keydown.enter="submitRename"
              @click.stop
            />
            <button class="pj-mini" @click.stop="submitRename">✓</button>
          </template>
          <template v-else>
            <span class="pj-name">{{ p.displayName }}</span>
            <button
              class="pj-mini"
              :title="t('project.rename')"
              @click.stop="((renaming = p.id), (renameName = p.displayName))"
            >✎</button>
            <button
              class="pj-mini danger"
              :title="t('project.delete')"
              @click.stop="((confirmingDelete = p.id))"
            >✕</button>
          </template>
        </li>
      </ul>

      <div v-if="confirmingDelete" class="pj-confirm">
        <p>{{ t("project.deleteConfirm") }}</p>
        <div class="pj-form-actions">
          <button class="pj-btn" @click="confirmingDelete = null">{{ t("conn.cancel") }}</button>
          <button
            class="pj-btn danger"
            @click="((store.remove(confirmingDelete)), (confirmingDelete = null))"
          >
            {{ t("project.delete") }}
          </button>
        </div>
      </div>

      <div class="pj-view">
        <div class="view-toolbar">
          <div class="filter-box">
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
            <button class="view-btn" :class="{ open: viewOpen }" @click="viewOpen = !viewOpen">
              ⚙ {{ t("mode.view") }}
            </button>
            <div v-if="viewOpen" class="view-pop">
              <div class="view-row">
                <span class="view-row-label">{{ t("project.viewLayout") }}</span>
                <div class="view-seg">
                  <button
                    v-for="m in modes"
                    :key="m.key"
                    class="view-seg-btn"
                    :class="{ active: modeKey === m.key }"
                    @click="modeKey = m.key"
                  >{{ t(m.labelKey) }}</button>
                </div>
              </div>
              <div class="view-row">
                <span class="view-row-label">{{ t("project.viewSort") }}</span>
                <select
                  class="view-select"
                  :value="store.sortBy"
                  @change="setSortBy(($event.target as HTMLSelectElement).value as 'manual' | 'priority' | 'added')"
                >
                  <option value="manual">{{ t("project.sortManual") }}</option>
                  <option value="priority">{{ t("project.sortPriority") }}</option>
                  <option value="added">{{ t("project.sortAdded") }}</option>
                </select>
              </div>
            </div>
          </div>
        </div>
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
.pj-input {
  box-sizing: border-box;
  width: 100%;
  font-size: 12px;
  font-family: inherit;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 5px 8px;
  outline: none;
}
.pj-input:focus {
  border-color: var(--accent);
}
.pj-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.pj-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 12px;
  height: 24px;
  padding: 0 12px;
  border-radius: 5px;
  cursor: pointer;
}
.pj-btn.primary {
  color: var(--accent);
  border-color: var(--accent);
  font-weight: 600;
}
.pj-btn.danger {
  color: var(--danger);
  border-color: var(--danger);
}
.pj-btn:disabled {
  opacity: 0.5;
  cursor: default;
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
.pj-list {
  list-style: none;
  display: flex;
  gap: 4px;
  margin: 0;
  padding: 8px 10px 0;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.pj-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
}
.pj-item:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.pj-item.active {
  background: var(--bg-selected);
  color: var(--accent);
  font-weight: 600;
}
.pj-name {
  white-space: nowrap;
}
.pj-mini {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
  padding: 0 2px;
}
.pj-mini:hover {
  color: var(--text);
}
.pj-mini.danger:hover {
  color: var(--danger);
}
.pj-confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 8px 12px 0;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
}
.pj-confirm p {
  margin: 0;
}
.pj-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
/* 视图工具栏：左筛选条 + 右 ⚙ View（对齐 GitHub Projects 两段式） */
.view-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  position: relative;
}
.filter-box {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
  min-height: 26px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel);
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
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 12px;
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
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
  width: 260px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.view-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--text);
}
.view-row-label {
  color: var(--text-dim);
}
.view-seg {
  display: flex;
  gap: 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px;
}
.view-seg-btn {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.view-seg-btn.active {
  background: var(--bg-selected);
  color: var(--accent);
  font-weight: 600;
}
.view-select {
  font-size: 12px;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 2px 4px;
}
</style>
