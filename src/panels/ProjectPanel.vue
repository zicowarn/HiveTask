<script setup lang="ts">
/**
 * Projects panel — the P4 board workspace (registered as "project.board").
 * Chrome hosts the project sidebar (create/rename/archive/delete) and the
 * Board/Table mode switch; the mode components render the selected project's
 * items from the projects store. Application-level: nothing here follows
 * repository switches.
 */
import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import ModeTabs from "../components/ModeTabs.vue";
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
const { projects, selectedId, loading, error } = storeToRefs(store);

const storedMode =
  modes.find((m) => m.key === localStorage.getItem(MODE_STORAGE_KEY))?.key ?? modes[0]?.key;
const modeKey = ref(storedMode);
const activeMode = computed(() => modes.find((m) => m.key === modeKey.value) ?? modes[0]);

onMounted(() => {
  void store.loadAll();
});

// ---- 新建项目 ----
const createOpen = ref(false);
const createName = ref("");
const createDesc = ref("");
async function submitCreate() {
  if (!createName.value.trim()) return;
  try {
    await store.create(createName.value, createDesc.value || undefined);
    createOpen.value = false;
    createName.value = "";
    createDesc.value = "";
  } catch (e) {
    store.error = String(e);
  }
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
    <template v-if="modes.length > 1" #switcher>
      <ModeTabs v-model="modeKey" :modes="modes" />
    </template>
    <template #actions>
      <button class="pj-add" @click="createOpen = !createOpen">
        {{ t("project.newBtn") }}
      </button>
    </template>

    <p v-if="error" class="pj-error">{{ error }}</p>

    <div v-if="createOpen" class="pj-form">
      <input
        v-model="createName"
        class="pj-input"
        :placeholder="t('project.namePlaceholder')"
        spellcheck="false"
        @keydown.enter="submitCreate"
      />
      <input
        v-model="createDesc"
        class="pj-input"
        :placeholder="t('project.descPlaceholder')"
        spellcheck="false"
        @keydown.enter="submitCreate"
      />
      <div class="pj-form-actions">
        <button class="pj-btn" @click="createOpen = false">{{ t("conn.cancel") }}</button>
        <button class="pj-btn primary" :disabled="!createName.trim()" @click="submitCreate">
          {{ t("issue.submit") }}
        </button>
      </div>
    </div>

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
        <component :is="activeMode.component" />
      </div>
    </div>
  </PanelShell>
</template>

<style scoped>
.pj-add {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 12px;
  height: 22px;
  padding: 0 12px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.pj-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.pj-error {
  margin: 8px 14px 0;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
}
.pj-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 8px 12px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-app);
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
</style>
