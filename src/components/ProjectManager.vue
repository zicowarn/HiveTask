<script setup lang="ts">
/**
 * Project manager — the "切换项目" dialog body (mirrors RepoManager's role
 * for the repo side): lists projects for switching, and hosts the create
 * form including repository binding chips grouped by connection label
 * (创建仿仓库登记——接入配置随仓库进项目). Works directly against the
 * projects store; the host dialog just toggles visibility.
 */
import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useProjectsStore } from "../stores/projects";
import { api } from "../api";
import { useI18n } from "../i18n";

const { t } = useI18n();
const store = useProjectsStore();
const { projects, selectedId } = storeToRefs(store);

onMounted(() => {
  void store.loadProjects();
});

function pick(id: string) {
  store.select(id);
}

// ---- 新建（名称 + 描述 + 绑定仓库多选，按接入配置标签分组） ----
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
const creating = ref(false);
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
  creating.value = true;
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
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <div class="pjmgr">
    <p v-if="projects.length === 0 && !createOpen" class="pjmgr-empty">{{ t("project.empty") }}</p>
    <ul v-else class="pjmgr-list">
      <li
        v-for="p in projects"
        :key="p.id"
        class="pjmgr-item"
        :class="{ active: p.id === selectedId }"
        @click="pick(p.id)"
      >
        <span class="pjmgr-name">{{ p.displayName }}</span>
        <span v-if="p.description" class="pjmgr-desc">{{ p.description }}</span>
      </li>
    </ul>

    <button class="pjmgr-new" :class="{ open: createOpen }" @click="toggleCreate">
      {{ createOpen ? "×" : "＋ 新建项目" }}
    </button>

    <div v-if="createOpen" class="pjmgr-form">
      <input
        v-model="createName"
        class="pjmgr-input"
        :placeholder="t('project.namePlaceholder')"
        spellcheck="false"
        @keydown.enter="submitCreate"
      />
      <input
        v-model="createDesc"
        class="pjmgr-input"
        :placeholder="t('project.descPlaceholder')"
        spellcheck="false"
        @keydown.enter="submitCreate"
      />
      <p class="pjmgr-bind-head">{{ t("project.bindRepos") }}</p>
      <div v-if="repoChoices.length === 0" class="pjmgr-bind-empty">{{ t("project.bindEmpty") }}</div>
      <div v-for="[group, choices] in repoGroups" :key="group" class="pjmgr-group">
        <span class="pjmgr-group-label">{{ group }}</span>
        <button
          v-for="c in choices"
          :key="c.id"
          class="pjmgr-chip"
          :class="{ chosen: chosenRepoIds.has(c.id) }"
          @click="toggleChoose(c.id)"
        >{{ c.label }}</button>
      </div>
      <div class="pjmgr-actions">
        <button class="pjmgr-btn" @click="createOpen = false">{{ t("conn.cancel") }}</button>
        <button class="pjmgr-btn primary" :disabled="!createName.trim() || creating" @click="submitCreate">
          {{ t("issue.submit") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pjmgr {
  padding: 8px;
}
.pjmgr-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  padding: 16px 0;
}
.pjmgr-list {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
}
.pjmgr-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}
.pjmgr-item:hover {
  border-color: var(--accent);
}
.pjmgr-item.active {
  border-color: var(--accent);
  background: var(--bg-selected);
}
.pjmgr-name {
  font-weight: 600;
}
.pjmgr-desc {
  color: var(--text-dim);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pjmgr-new {
  width: 100%;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
}
.pjmgr-new:hover,
.pjmgr-new.open {
  border-color: var(--accent);
  color: var(--accent);
}
.pjmgr-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-app);
}
.pjmgr-input {
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
.pjmgr-input:focus {
  border-color: var(--accent);
}
.pjmgr-bind-head {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--text-dim);
}
.pjmgr-bind-empty {
  font-size: 11px;
  color: var(--text-dim);
}
.pjmgr-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
}
.pjmgr-group-label {
  font-size: 10px;
  color: var(--accent);
  min-width: 64px;
}
.pjmgr-chip {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-dim);
  font-size: 11px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  cursor: pointer;
}
.pjmgr-chip.chosen {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--bg-selected);
}
.pjmgr-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.pjmgr-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 12px;
  height: 24px;
  padding: 0 12px;
  border-radius: 5px;
  cursor: pointer;
}
.pjmgr-btn.primary {
  color: var(--accent);
  border-color: var(--accent);
  font-weight: 600;
}
.pjmgr-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
