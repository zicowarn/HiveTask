<script setup lang="ts">
/**
 * 仓库管理面板（切换仓库的载体）：按来源分 Tab 列出已登记仓库，
 * 支持删除（只删登记指针）与新增（本地文件夹；仅远端 URL 为阶段 B）。
 * 数据来自 app.db 登记表（appdb.rs），选择仓库仍走 repo.setCurrent。
 */
import { computed, onMounted, ref, watch } from "vue";
import { translateError } from "../gh-errors";
import { api, isTauri } from "../api";
import { useI18n } from "../i18n";
import { useRepoStore } from "../stores/repo";
import EditorIcon from "./EditorIcon.vue";
import DropdownMenu from "./DropdownMenu.vue";

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
  visibility?: string | null;
  lastOpenedAt: string;
}

interface ConnectionInfo {
  id: string;
  platform: string;
  host: string;
  label: string;
}

const repos = ref<RepoEntry[]>([]);
const connections = ref<ConnectionInfo[]>([]);
const remoteFormOpen = ref(false);
const remoteUrl = ref("");
const loading = ref(false);
// Tab = 来源连接（第一分类），收尾「本地」收容未挂连接的仓库。
const activeTab = ref<string>("local");
const remoteConnectionId = ref("");
// ---- 线上清单（⟳ 从线上查找）：Tab 行右侧刷新按钮拉取，勾选登记 ----
interface OnlineRepo {
  fullName: string;
  url: string;
  description: string | null;
  updatedAt: string | null;
}
const onlineOpen = ref(false);
const onlineLoading = ref(false);
const onlineError = ref<string | null>(null);
const onlineRepos = ref<OnlineRepo[]>([]);

const activeConnection = computed(() => connections.value.find((c) => c.id === activeTab.value));

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
    onlineError.value = translateError(String(e));
    onlineRepos.value = [];
  } finally {
    onlineLoading.value = false;
  }
}
/** 已登记（该连接下 remoteUrl 命中）→ 置灰不可重复登记。 */
function isRegistered(url: string): boolean {
  return repos.value.some((r) => r.remoteUrl && r.remoteUrl.replace(/\.git$/, "") === url.replace(/\.git$/, ""));
}
async function registerOnline(repo: OnlineRepo) {
  const conn = activeConnection.value;
  if (!conn) return;
  await api.repoRegisterRemote(repo.url, conn.platform);
  await load();
}

/** 远端 URL 挂到哪条连接——用户显式选择（知识库：运行时只认连接类型，
 * 自建 Gitea 域名等猜测不了的来源全靠它）。 */
// 打开添加表单 → 预填当前 Tab 的连接；本地 Tab 维持上次选择。
// 切 Tab 关闭线上清单（线上数据按连接拉取，不跨 Tab 复用）。
watch([activeTab, remoteFormOpen], ([tab, open]) => {
  if (!open) return;
  if (tab !== "local") remoteConnectionId.value = tab;
  if (!remoteConnectionId.value && connections.value.length) {
    remoteConnectionId.value = connections.value[0]!.id;
  }
});
watch(activeTab, () => {
  onlineOpen.value = false;
  onlineRepos.value = [];
});

/** 仓库 → Tab：只认登记连接（显式绑定），无连接 → 本地。
 * 前端不做域名猜测（自建域名猜不出，猜错更糟——知识库连接篇定案）。 */
function tabOf(entry: RepoEntry): string {
  return entry.connectionId ?? "local";
}

const tabs = computed(() => {
  const connTabs = connections.value.map((c) => ({
    key: c.id,
    label: c.label || c.host,
    count: repos.value.filter((r) => r.connectionId === c.id).length,
  }));
  connTabs.push({
    key: "local",
    label: t("repoTab.local"),
    count: repos.value.filter((r) => !r.connectionId).length,
  });
  return connTabs;
});

const visibleRepos = computed(() =>
  repos.value
    .filter((r) => tabOf(r) === activeTab.value)
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)),
);

async function load() {
  if (!isTauri()) return;
  loading.value = true;
  try {
    repos.value = (await api.repoList()) as RepoEntry[];
    connections.value = await api.connectionList();
    // 当前 Tab 失效（连接被删等）→ 回到第一个 Tab
    if (!tabs.value.some((tb) => tb.key === activeTab.value)) {
      activeTab.value = tabs.value[0]?.key ?? "local";
    }
  } finally {
    loading.value = false;
  }
  void probeMissingVisibility();
}

/** 后台补探缺可见性的行（有连接才有平台语义），逐个写回本地数组
 * （命令层同时落登记表缓存；已探测过的不重打 API）。 */
async function probeMissingVisibility() {
  for (const entry of repos.value) {
    if (entry.visibility || !entry.platform) continue;
    const target = entry.path ?? entry.remoteUrl;
    if (!target) continue;
    try {
      const v = await api.repoVisibility(target);
      entry.visibility = v ?? null;
    } catch {
      // 探测失败留空（无锁）——下回路过后不再重试同一轮。
    }
  }
}

onMounted(load);

function nameOf(entry: RepoEntry): string {
  return entry.displayName ?? entry.path?.split("/").filter(Boolean).pop() ?? entry.remoteUrl ?? "?";
}

function pick(entry: RepoEntry) {
  // 仅远端登记同样可切换（target = remote_url，Issue/PR 走 API）
  const target = entry.path ?? entry.remoteUrl;
  if (!target) return;
  repoStore.setCurrent(target);
  emit("select", target);
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
  const conn = connections.value.find((c) => c.id === remoteConnectionId.value);
  if (!conn) return;
  await api.repoRegisterRemote(url, conn.platform);
  remoteUrl.value = "";
  remoteFormOpen.value = false;
  await load();
  activeTab.value = conn.id;
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
        {{ tab.label }} <span class="tab-count">{{ tab.count }}</span>
      </button>
      <span class="tabs-spacer"></span>
      <button
        v-if="activeTab !== 'local'"
        class="online-toggle"
        :class="{ open: onlineOpen }"
        :disabled="onlineLoading"
        :title="t('repo.refreshOnline')"
        @click="toggleOnline"
      >{{ onlineLoading ? t("list.loading") : t("common.refresh") }}</button>
    </div>

    <div v-if="onlineOpen && activeTab !== 'local'" class="online-panel">
      <p v-if="onlineError" class="online-error">{{ onlineError }}</p>
      <p v-else-if="onlineRepos.length === 0 && !onlineLoading" class="note">
        {{ t("repo.onlineEmpty") }}
      </p>
      <ul v-else class="online-list">
        <li v-for="r in onlineRepos" :key="r.url" class="online-item">
          <div class="online-main">
            <span class="online-name">{{ r.fullName }}</span>
            <span v-if="r.description" class="online-desc">{{ r.description }}</span>
          </div>
          <button
            v-if="isRegistered(r.url)"
            class="online-btn done"
            disabled
          >✓ {{ t("repo.registered") }}</button>
          <button v-else class="online-btn" :disabled="onlineLoading" @click="registerOnline(r)">
            {{ t("repo.register") }}
          </button>
        </li>
      </ul>
    </div>

    <div v-if="remoteFormOpen" class="remote-form">
      <label class="remote-platform">
        <span class="remote-platform-label">{{ t("repo.remoteConnection") }}</span>
        <DropdownMenu
          class="remote-select"
          :options="connections.map((c) => ({ value: c.id, label: c.label || c.host }))"
          v-model="remoteConnectionId"
          :placeholder="t('repo.remoteConnection')"
        />
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
        role="button"
        :class="{ current: entry.path === repoStore.current }"
        @click="pick(entry)"
      >
        <span class="repo-name">{{ nameOf(entry) }}</span>
        <span
          v-if="entry.visibility"
          class="repo-vis"
          :title="t(entry.visibility === 'private' ? 'repo.visibilityPrivate' : 'repo.visibilityPublic')"
        ><EditorIcon :name="entry.visibility === 'private' ? 'lock' : 'unlock'" /></span>
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

    <div class="add-area">
      <button class="panel-add" @click="pickLocal">{{ t("repo.addLocal") }}</button>
      <button
        class="panel-add"
        :class="{ active: remoteFormOpen }"
        @click="remoteFormOpen = !remoteFormOpen"
      >{{ t("repo.addRemote") }}</button>
    </div>
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
  font-size: var(--font-md);
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
  font-size: var(--font-xs);
  opacity: 0.75;
}
.tabs-spacer {
  flex: 1;
}
.online-toggle {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  height: 22px;
  padding: 0 10px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.online-toggle:hover,
.online-toggle.open {
  border-color: var(--accent);
  color: var(--accent);
}
.online-toggle:disabled {
  opacity: 0.5;
  cursor: default;
}
.online-panel {
  max-height: 220px;
  overflow-y: auto;
  margin: 6px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px;
}
.online-error {
  margin: 0;
  padding: 6px;
  font-size: var(--font-md);
  color: var(--danger);
}
.online-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.online-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 5px;
  font-size: var(--font-md);
}
.online-item:hover {
  background: var(--bg-hover);
}
.online-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.online-name {
  color: var(--text);
  font-weight: 600;
  white-space: nowrap;
}
.online-desc {
  color: var(--text-dim);
  font-size: var(--font-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.online-btn {
  flex: none;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--accent);
  font-size: var(--font-sm);
  height: 20px;
  padding: 0 8px;
  border-radius: 5px;
  cursor: pointer;
}
.online-btn.done {
  color: var(--text-dim);
  cursor: default;
}
.add-btn {
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-sm);
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
/* 添加区：列表底部虚线双钮横排，共享一个虚线外框、中间实线细缝
   （split-button 形态）——与来源连接对话框虚线配方同源，动作与分类
   分离，标签行只做浏览。上方水平线与标签行 border-bottom 呼应：
   上线分隔「分类/内容」，此线分隔「内容/动作」。共享外框故
   hover/active 只染文字与浅底。 */
.add-area {
  display: flex;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.panel-add {
  flex: 1;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  height: 28px;
  cursor: pointer;
}
.panel-add:first-child {
  border-radius: 6px 0 0 6px;
  border-right: none;
}
.panel-add:last-child {
  border-radius: 0 6px 6px 0;
  border-left: 1px solid var(--border);
}
.panel-add:hover,
.panel-add.active {
  color: var(--accent);
  background: var(--bg-selected);
}
.remote-platform {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.remote-platform-label {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 下拉：统一 DropdownMenu 组件（AGENTS.md 下拉菜单规范） */
.remote-select {
  width: 100%;
}
.remote-select:focus {
  border-color: var(--accent);
}
.remote-input {
  flex: 1;
  box-sizing: border-box;
  font-size: var(--font-md);
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
  font-size: var(--font-md);
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
  font-size: var(--font-md);
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
  font-size: var(--font-xs);
  color: var(--text-dim);
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 0 6px;
}
.repo-vis {
  display: inline-flex;
  color: var(--text-dim);
}
.repo-current {
  font-size: var(--font-xs);
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 8px;
  padding: 0 6px;
}
.repo-meta {
  margin-left: auto;
  font-size: var(--font-sm);
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
  font-size: var(--font-sm);
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
