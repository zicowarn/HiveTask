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
import { api } from "../api";
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

// ---- 新建项目（仿仓库登记：创建时绑定仓库，接入配置标签随仓库携带）----
const createOpen = ref(false);
const createName = ref("");
const createDesc = ref("");
interface RepoChoice {
  id: string;
  label: string;
  group: string;
}
const repoChoices = ref<RepoChoice[]>([]);
const chosenRepoIds = ref<Set<string>>(new Set());
const repoGroups = computed(() => {
  const groups = new Map<string, RepoChoice[]>();
  for (const r of repoChoices.value) {
    const g = groups.get(r.group) ?? [];
    g.push(r);
    groups.set(r.group, g);
  }
  return [...groups.entries()];
});
async function toggleCreate() {
  createOpen.value = !createOpen.value;
  if (createOpen.value && repoChoices.value.length === 0) {
    try {
      const rows = (await api.repoList()) as Array<{
        id: string;
        displayName?: string | null;
        path?: string | null;
        remoteUrl?: string | null;
        connectionLabel?: string | null;
        platform?: string | null;
      }>;
      repoChoices.value = rows.map((r) => ({
        id: r.id,
        label:
          r.displayName ?? r.path?.split("/").filter(Boolean).pop() ?? r.remoteUrl ?? r.id,
        group: r.connectionLabel ?? r.platform ?? t("repoTab.local"),
      }));
    } catch {
      repoChoices.value = [];
    }
  }
}
function toggleChoose(id: string) {
  const next = new Set(chosenRepoIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  chosenRepoIds.value = next;
}
async function submitCreate() {
  if (!createName.value.trim()) return;
  try {
    await store.create(createName.value, createDesc.value || undefined);
    for (const repoId of chosenRepoIds.value) {
      await store.bindRepo(repoId);
    }
    createOpen.value = false;
    createName.value = "";
    createDesc.value = "";
    chosenRepoIds.value = new Set();
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
      <button class="pj-add" @click="toggleCreate">
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
      <p class="pj-bind-head">{{ t("project.bindRepos") }}</p>
      <div v-if="repoChoices.length === 0" class="pj-bind-empty">{{ t("project.bindEmpty") }}</div>
      <div v-for="[group, choices] in repoGroups" :key="group" class="pj-bind-group">
        <span class="pj-bind-group-label">{{ group }}</span>
        <button
          v-for="c in choices"
          :key="c.id"
          class="pj-chip"
          :class="{ chosen: chosenRepoIds.has(c.id) }"
          @click="toggleChoose(c.id)"
        >{{ c.label }}</button>
      </div>
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
.pj-bind-head {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--text-dim);
}
.pj-bind-empty {
  font-size: 11px;
  color: var(--text-dim);
}
.pj-bind-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.pj-bind-group-label {
  font-size: 10px;
  color: var(--accent);
  min-width: 64px;
}
.pj-chip {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-dim);
  font-size: 11px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  cursor: pointer;
}
.pj-chip.chosen {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--bg-selected);
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
