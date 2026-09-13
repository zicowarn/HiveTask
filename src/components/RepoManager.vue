<script setup lang="ts">
/**
 * 仓库管理面板（切换仓库的载体）：按来源分 Tab 列出已登记仓库，
 * 支持删除（只删登记指针）与新增（本地文件夹；仅远端 URL 为阶段 B）。
 * 数据来自 app.db 登记表（appdb.rs），选择仓库仍走 repo.setCurrent。
 */
import { computed, onMounted, ref, watch } from "vue";
import { api, isTauri } from "../api";
import { useI18n } from "../i18n";
import { useRepoStore } from "../stores/repo";

const emit = defineEmits<{ close: []; select: [path: string] }>();

const { t } = useI18n();
const repoStore = useRepoStore();

interface RepoEntry {
  id: string;
  path?: string | null;
  remoteUrl?: string | null;
  displayName?: string | null;
  connectionId?: string | null;
  connectionLabel?: string | null;
  platform?: string | null;
  lastOpenedAt: string;
}

const repos = ref<RepoEntry[]>([]);
const remoteFormOpen = ref(false);
const remoteUrl = ref("");
const loading = ref(false);
const activeTab = ref<string>("local");

/** 远端 URL 登记的平台——用户显式选择（知识库：运行时只认连接类型，
 * 自建 Gitea 域名等猜测不了的来源全靠它）。 */
const REMOTE_PLATFORMS: { value: "github" | "gitee" | "gitea"; labelKey: "repoTab.github" | "repoTab.gitee" | "repoTab.gitea" }[] = [
  { value: "github", labelKey: "repoTab.github" },
  { value: "gitee", labelKey: "repoTab.gitee" },
  { value: "gitea", labelKey: "repoTab.gitea" },
];
const remotePlatform = ref<"github" | "gitee" | "gitea">("github");

// 在平台 Tab 下打开添加表单 → 预填该平台；本地 Tab 维持上次选择。
watch([activeTab, remoteFormOpen], ([tab, open]) => {
  if (open && tab !== "local") remotePlatform.value = tab as typeof remotePlatform.value;
});

const TAB_ORDER: { key: string; labelKey: "repoTab.github" | "repoTab.gitee" | "repoTab.gitea" | "repoTab.local" }[] = [
  { key: "github", labelKey: "repoTab.github" },
  { key: "gitee", labelKey: "repoTab.gitee" },
  { key: "gitea", labelKey: "repoTab.gitea" },
  { key: "local", labelKey: "repoTab.local" },
];

/** 仓库 → 平台 Tab：只认登记连接的 platform（显式/auto），无连接 → 本地。
 * 前端不做域名猜测（自建域名猜不出，猜错更糟——知识库连接篇定案）。 */
function platformOf(entry: RepoEntry): string {
  return entry.platform ?? "local";
}

const tabs = computed(() => {
  const present = new Set(repos.value.map(platformOf));
  return TAB_ORDER.filter((t) => present.has(t.key) || t.key === "local").map((t) => ({
    ...t,
    count: repos.value.filter((r) => platformOf(r) === t.key).length,
  }));
});

const visibleRepos = computed(() =>
  repos.value
    .filter((r) => platformOf(r) === activeTab.value)
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)),
);

async function load() {
  if (!isTauri()) return;
  loading.value = true;
  try {
    repos.value = (await api.repoList()) as RepoEntry[];
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function nameOf(entry: RepoEntry): string {
  return entry.displayName ?? entry.path?.split("/").filter(Boolean).pop() ?? entry.remoteUrl ?? "?";
}

function pick(entry: RepoEntry) {
  if (!entry.path) return; // 仅远端登记（阶段 B）暂不可选
  repoStore.setCurrent(entry.path);
  emit("select", entry.path);
}

async function pickLocal() {
  if (!isTauri()) return;
  const path = await import("../api").then((m) => m.api.pickRepo());
  if (!path) return;
  await api.repoRegister(path);
  await load();
  emit("select", path);
}

async function addRemote() {
  const url = remoteUrl.value.trim();
  if (!url) return;
  await api.repoRegisterRemote(url, remotePlatform.value);
  remoteUrl.value = "";
  remoteFormOpen.value = false;
  await load();
  activeTab.value = remotePlatform.value;
  // 仅远端登记的标识就是 URL 本身——切换过去（Issue/PR 走 API）。
  emit("select", url);
}

async function remove(entry: RepoEntry) {
  await api.repoDelete(entry.id);
  await load();
}
</script>

<template>
  <div class="repo-manager">
    <div class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ t(tab.labelKey) }} <span class="tab-count">{{ tab.count }}</span>
      </button>
      <span class="tabs-spacer"></span>
      <button class="add-btn" @click="pickLocal">{{ t("repo.addLocal") }}</button>
      <button
        class="add-btn"
        :class="{ active: remoteFormOpen }"
        @click="remoteFormOpen = !remoteFormOpen"
      >{{ t("repo.addRemote") }}</button>
    </div>

    <div v-if="remoteFormOpen" class="remote-form">
      <label class="remote-platform">
        <span class="remote-platform-label">{{ t("repo.remotePlatform") }}</span>
        <select v-model="remotePlatform" class="remote-select">
          <option v-for="p in REMOTE_PLATFORMS" :key="p.value" :value="p.value">
            {{ t(p.labelKey) }}
          </option>
        </select>
      </label>
      <input
        v-model.trim="remoteUrl"
        class="remote-input"
        :placeholder="t('repo.remotePlaceholder')"
        spellcheck="false"
        @keydown.enter="addRemote"
      />
      <button class="add-btn" :disabled="!remoteUrl" @click="addRemote">
        {{ t("settings.save") }}
      </button>
    </div>

    <p v-if="loading" class="note">{{ t("common.loadingFull") }}</p>
    <p v-else-if="visibleRepos.length === 0" class="note">{{ t("repo.tabEmpty") }}</p>
    <ul v-else class="repo-list">
      <li
        v-for="entry in visibleRepos"
        :key="entry.id"
        class="repo-item"
        :class="{ current: entry.path === repoStore.current }"
        @click="pick(entry)"
      >
        <span class="repo-name">{{ nameOf(entry) }}</span>
        <span v-if="!entry.path" class="repo-remote-flag">{{ t("repo.remoteOnly") }}</span>
        <span v-if="entry.path === repoStore.current" class="repo-current">{{ t("repo.current") }}</span>
        <span class="repo-meta">{{ entry.connectionLabel ?? entry.remoteUrl ?? entry.path }}</span>
        <button
          class="repo-delete"
          :title="t('repo.deleteTitle')"
          @click.stop="remove(entry)"
        >✕</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.repo-manager {
  padding: 8px;
}
.tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 4px 8px;
  border-bottom: 1px solid var(--border);
}
.tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  padding: 4px 9px;
  border-radius: 5px;
  cursor: pointer;
}
.tab:hover {
  color: var(--text);
}
.tab.active {
  background: var(--bg-selected);
  color: var(--accent);
  font-weight: 600;
}
.tab-count {
  font-size: 10px;
  opacity: 0.75;
}
.tabs-spacer {
  flex: 1;
}
.add-btn {
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  font-size: 11px;
  height: 22px;
  padding: 0 8px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.add-btn:hover:not(.disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.add-btn.active {
  border-color: var(--accent);
  color: var(--accent);
}
.remote-form {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
}
.remote-platform {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.remote-platform-label {
  font-size: 11px;
  color: var(--text-dim);
}
/* 下拉与输入框同款扁平样式；select 必须 appearance:none，
   否则 macOS 画原生渐变/立体外观（此前踩过）。 */
.remote-select {
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  font-size: 12px;
  color: var(--text);
  background-color: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  height: 24px;
  padding: 0 22px 0 8px;
  outline: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' fill='none' stroke='%239aa0a8' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 7px center;
  background-size: 8px;
}
.remote-select:focus {
  border-color: var(--accent);
}
.remote-input {
  flex: 1;
  box-sizing: border-box;
  font-size: 12px;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  height: 24px;
  padding: 0 8px;
  outline: none;
}
.remote-input:focus {
  border-color: var(--accent);
}
.note {
  padding: 20px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
}
.repo-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
}
.repo-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.repo-item:hover {
  background: var(--bg-hover);
}
.repo-item.current {
  background: var(--bg-selected);
}
.repo-name {
  color: var(--text);
  font-weight: 500;
}
.repo-remote-flag {
  font-size: 10px;
  color: var(--text-dim);
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 0 6px;
}
.repo-current {
  font-size: 10px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 0 6px;
}
.repo-meta {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 45%;
}
.repo-delete {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  opacity: 0;
}
.repo-item:hover .repo-delete {
  opacity: 1;
}
.repo-delete:hover {
  color: var(--danger);
  background: var(--bg-hover);
}
</style>
