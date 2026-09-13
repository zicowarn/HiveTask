<script setup lang="ts">
/**
 * 仓库管理面板（切换仓库的载体）：按来源分 Tab 列出已登记仓库，
 * 支持删除（只删登记指针）与新增（本地文件夹；仅远端 URL 为阶段 B）。
 * 数据来自 app.db 登记表（appdb.rs），选择仓库仍走 repo.setCurrent。
 */
import { computed, onMounted, ref } from "vue";
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
const loading = ref(false);
const activeTab = ref<string>("local");

const TAB_ORDER: { key: string; labelKey: "repoTab.github" | "repoTab.gitee" | "repoTab.gitea" | "repoTab.local" }[] = [
  { key: "github", labelKey: "repoTab.github" },
  { key: "gitee", labelKey: "repoTab.gitee" },
  { key: "gitea", labelKey: "repoTab.gitea" },
  { key: "local", labelKey: "repoTab.local" },
];

/** 仓库 → 平台 Tab（connection 派生优先，否则 host 推断，无 remote → local）。 */
function platformOf(entry: RepoEntry): string {
  if (entry.platform) return entry.platform;
  const url = entry.remoteUrl;
  if (url) {
    const s = url.replace(/^https?:\/\//, "").replace(/^[^@]*@/, "");
    const host = (s.split("/")[0] ?? "").split(":")[0].toLowerCase();
    if (host.includes("github")) return "github";
    if (host === "gitee.com" || host.endsWith(".gitee.com")) return "gitee";
    if (host.includes("gitea")) return "gitea";
  }
  return "local";
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
      <button class="add-btn disabled" :title="t('repo.remoteLater')">{{ t("repo.addRemote") }}</button>
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
.add-btn.disabled {
  opacity: 0.45;
  cursor: not-allowed;
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
