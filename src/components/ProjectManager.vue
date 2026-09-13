<script setup lang="ts">
/**
 * Project manager — the "切换项目" dialog body, structurally mirroring
 * RepoManager: tabs = source connections, projects listed under their
 * owning connection (NULL = 本地 tab), create form binds repos of the
 * active connection (with 线上列表 lookup). Works directly against the
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

// ---- 接入 Tab（与切换仓库同构）----
interface ConnectionInfo {
  id: string;
  platform: string;
  host: string;
  label: string;
}
const connections = ref<ConnectionInfo[]>([]);
const activeTab = ref<string>("local");

const allRepos = ref<Array<{ id: string; displayName?: string | null; path?: string | null; remoteUrl?: string | null; connectionId?: string | null }>>([]);
const chosenRepoIds = ref<Set<string>>(new Set());

const tabs = computed(() => {
  const connTabs = connections.value.map((c) => ({
    key: c.id,
    label: c.label || c.host,
    count: projects.value.filter((p) => p.connectionId === c.id).length,
  }));
  connTabs.push({
    key: "local",
    label: t("repoTab.local"),
    count: projects.value.filter((p) => !p.connectionId).length,
  });
  return connTabs;
});

const activeConnection = computed(() => connections.value.find((c) => c.id === activeTab.value) ?? null);

const visibleProjects = computed(() =>
  projects.value
    .filter((p) => (p.connectionId ?? "local") === activeTab.value)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
);

// ---- 新建（名称 + 描述 + 绑定该接入下的仓库；线上列表可拉取）----
const createOpen = ref(false);
const createName = ref("");
const createDesc = ref("");
const creating = ref(false);

const tabRepoChoices = computed(() =>
  allRepos.value
    .filter((r) => (activeConnection.value ? r.connectionId === activeTab.value : !r.connectionId))
    .map((r) => ({
      id: r.id,
      label: r.displayName ?? r.path?.split("/").filter(Boolean).pop() ?? r.remoteUrl ?? r.id,
    })),
);

interface OnlineRepo {
  fullName: string;
  url: string;
  description: string | null;
  updatedAt: string | null;
}
const onlineOpen = ref(false);
const onlineLoading = ref(false);
const onlineRepos = ref<OnlineRepo[]>([]);
const onlineError = ref<string | null>(null);

function isRegistered(url: string): boolean {
  return allRepos.value.some(
    (r) => r.remoteUrl && r.remoteUrl.replace(/\.git$/, "") === url.replace(/\.git$/, ""),
  );
}

async function toggleCreate() {
  createOpen.value = !createOpen.value;
  if (createOpen.value && allRepos.value.length === 0) {
    try {
      allRepos.value = (await api.repoList()) as typeof allRepos.value;
      connections.value = await api.connectionList();
    } catch {
      allRepos.value = [];
      connections.value = [];
    }
  }
}
function toggleChoose(id: string) {
  const next = new Set(chosenRepoIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  chosenRepoIds.value = next;
}
async function toggleOnline() {
  onlineOpen.value = !onlineOpen.value;
  if (onlineOpen.value) await fetchOnline();
}
async function fetchOnline() {
  const conn = activeConnection.value;
  if (!conn) return;
  onlineLoading.value = true;
  onlineError.value = null;
  try {
    onlineRepos.value = await api.remoteRepoList(conn.platform, conn.host);
  } catch (e) {
    onlineError.value = String(e);
    onlineRepos.value = [];
  } finally {
    onlineLoading.value = false;
  }
}
/** 线上仓库勾选 = 登记（未登记时）+ 绑定：一步进项目。 */
async function chooseOnline(repo: OnlineRepo) {
  const conn = activeConnection.value;
  if (!conn) return;
  const existing = allRepos.value.find(
    (r) => r.remoteUrl && r.remoteUrl.replace(/\.git$/, "") === repo.url.replace(/\.git$/, ""),
  );
  let repoId = existing?.id;
  if (!repoId) {
    const entry = await api.repoRegisterRemote(repo.url, conn.platform);
    repoId = (entry as { id: string }).id;
    allRepos.value.push({ id: repoId, remoteUrl: repo.url, displayName: repo.fullName, connectionId: conn.id });
  }
  if (!chosenRepoIds.value.has(repoId)) toggleChoose(repoId);
}
async function submitCreate() {
  if (!createName.value.trim()) return;
  creating.value = true;
  try {
    await store.create(
      createName.value,
      createDesc.value || undefined,
      activeTab.value !== "local" ? activeTab.value : undefined,
    );
    for (const repoId of chosenRepoIds.value) {
      await store.bindRepo(repoId);
    }
    createOpen.value = false;
    createName.value = "";
    createDesc.value = "";
    chosenRepoIds.value = new Set();
    onlineOpen.value = false;
    onlineRepos.value = [];
  } catch (e) {
    store.error = String(e);
  } finally {
    creating.value = false;
  }
}

// ---- 行内改名 / 删除（两击确认，级联由后端承担） ----
const renaming = ref<string | null>(null);
const renameName = ref("");
async function submitRename() {
  if (!renaming.value || !renameName.value.trim()) return;
  await store.rename(renaming.value, renameName.value);
  renaming.value = null;
}
const confirmingDelete = ref<string | null>(null);
async function confirmDelete() {
  if (!confirmingDelete.value) return;
  await store.remove(confirmingDelete.value);
  confirmingDelete.value = null;
}
</script>

<template>
  <div class="pjmgr">
    <div class="pjmgr-tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="pjmgr-tab"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }} <span class="pjmgr-count">{{ tab.count }}</span>
      </button>
    </div>

    <p v-if="projects.length === 0 && !createOpen" class="pjmgr-empty">{{ t("project.empty") }}</p>
    <p v-else-if="visibleProjects.length === 0" class="pjmgr-empty">{{ t("project.tabEmpty") }}</p>
    <ul v-else class="pjmgr-list">
      <li
        v-for="p in visibleProjects"
        :key="p.id"
        class="pjmgr-item"
        :class="{ active: p.id === selectedId }"
        @click="pick(p.id)"
      >
        <template v-if="renaming === p.id">
          <input
            v-model="renameName"
            class="pjmgr-input"
            @keydown.enter="submitRename"
            @keydown.escape="renaming = null"
            @click.stop
          />
          <button class="pjmgr-rowbtn" @click.stop="submitRename">✓</button>
        </template>
        <template v-else-if="confirmingDelete === p.id">
          <span class="pjmgr-confirm-text">{{ t("project.deleteConfirm") }}</span>
          <button class="pjmgr-rowbtn danger" @click.stop="confirmDelete">✓</button>
          <button class="pjmgr-rowbtn" @click.stop="confirmingDelete = null">×</button>
        </template>
        <template v-else>
          <span class="pjmgr-name">{{ p.displayName }}</span>
          <span v-if="p.description" class="pjmgr-desc">{{ p.description }}</span>
          <button
            class="pjmgr-rowbtn"
            :title="t('project.rename')"
            @click.stop="((renaming = p.id), (renameName = p.displayName))"
          >✎</button>
          <button
            class="pjmgr-rowbtn danger"
            :title="t('project.delete')"
            @click.stop="confirmingDelete = p.id"
          >✕</button>
        </template>
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
      <div v-if="tabRepoChoices.length === 0 && !onlineOpen" class="pjmgr-bind-empty">
        {{ t("project.bindEmpty") }}
      </div>
      <div v-else class="pjmgr-bind-chips">
        <button
          v-for="c in tabRepoChoices"
          :key="c.id"
          class="pjmgr-chip"
          :class="{ chosen: chosenRepoIds.has(c.id) }"
          @click="toggleChoose(c.id)"
        >{{ c.label }}</button>
      </div>

      <div v-if="activeConnection" class="pjmgr-online-wrap">
        <button
          class="pjmgr-online-toggle"
          :disabled="onlineLoading"
          @click="toggleOnline"
        >{{ onlineLoading ? t("list.loading") : onlineOpen ? "× " + t("repo.refreshOnline") : t("repo.refreshOnline") }}</button>
        <div v-if="onlineOpen" class="pjmgr-online">
          <p v-if="onlineError" class="pjmgr-online-error">{{ onlineError }}</p>
          <p v-else-if="onlineRepos.length === 0 && !onlineLoading" class="pjmgr-bind-empty">
            {{ t("repo.onlineEmpty") }}
          </p>
          <div v-for="r in onlineRepos" :key="r.url" class="pjmgr-online-item">
            <span class="pjmgr-online-name">{{ r.fullName }}</span>
            <button
              class="pjmgr-chip"
              :class="{ chosen: isRegistered(r.url) && chosenRepoIds.has(allRepos.find((x) => x.remoteUrl?.replace(/\.git$/, '') === r.url.replace(/\.git$/, ''))?.id ?? '') }"
              :disabled="onlineLoading"
              @click="chooseOnline(r)"
            >
              {{ isRegistered(r.url) ? t("project.bind") : t("project.bindRegister") }}
            </button>
          </div>
        </div>
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
.pjmgr-tabs {
  display: flex;
  gap: 2px;
  padding-bottom: 6px;
  margin-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.pjmgr-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 5px;
  cursor: pointer;
}
.pjmgr-tab:hover {
  color: var(--text);
}
.pjmgr-tab.active {
  background: var(--bg-selected);
  color: var(--accent);
  font-weight: 600;
}
.pjmgr-count {
  font-size: 10px;
  opacity: 0.75;
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
  white-space: nowrap;
}
.pjmgr-desc {
  color: var(--text-dim);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.pjmgr-rowbtn {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
  padding: 0 3px;
}
.pjmgr-rowbtn:hover {
  color: var(--text);
}
.pjmgr-rowbtn.danger:hover {
  color: var(--danger);
}
.pjmgr-confirm-text {
  font-size: 11px;
  color: var(--danger);
  flex: 1;
}
.pjmgr-item input.pjmgr-input {
  padding: 1px 6px;
  height: 20px;
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
.pjmgr-bind-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.pjmgr-online-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pjmgr-online-toggle {
  align-self: flex-start;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 11px;
  height: 20px;
  padding: 0 8px;
  border-radius: 5px;
  cursor: pointer;
}
.pjmgr-online-toggle:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.pjmgr-online-toggle:disabled {
  opacity: 0.5;
  cursor: default;
}
.pjmgr-online {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px;
}
.pjmgr-online-error {
  margin: 0;
  font-size: 11px;
  color: var(--danger);
}
.pjmgr-online-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
}
.pjmgr-online-name {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
