<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import WorkbenchNode from "./workbench/WorkbenchNode.vue";
import StatusBar from "./workbench/StatusBar.vue";
import AppMenu from "./components/AppMenu.vue";
import ProjectManager from "./components/ProjectManager.vue";
import AboutDialog from "./components/AboutDialog.vue";
import RepoManager from "./components/RepoManager.vue";
import EditorIcon from "./components/EditorIcon.vue";
import ToastHost from "./components/ToastHost.vue";
import { workspaces } from "./workbench/registry";
import { buildMenuDefs } from "./menu-defs";
import { syncApplicationMenu } from "./native-menu";
import { openExternalUrl } from "./open-url";
import { api, isTauri } from "./api";
import { useRepoStore } from "./stores/repo";
import { useIssuesStore } from "./stores/issues";
import { usePullsStore } from "./stores/pulls";
import { useProjectsStore } from "./stores/projects";
import { useSettingsStore } from "./stores/settings";
import { useWorkbenchStore } from "./stores/workbench";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";
import { probeNow } from "./net";
import { shortOrigin } from "./origin";

const WORKSPACE_KEY = "hivetask.workspace";

const repo = useRepoStore();
const issues = useIssuesStore();
const pulls = usePullsStore();
const projectsStore = useProjectsStore();
const settings = useSettingsStore();
const workbench = useWorkbenchStore();
const { current, origin, visibility } = storeToRefs(repo);
const { t } = useI18n();
const { theme, resolvedTheme, cycleTheme } = useTheme();

// Browser preview has no system menubar — there the in-header AppMenu and
// a webview keydown handler stand in; in Tauri the native menu owns both.
const inTauri = isTauri();

const activeKey = ref(localStorage.getItem(WORKSPACE_KEY) ?? "issues");
const active = computed(
  () => workspaces.find((w) => w.key === activeKey.value) ?? workspaces[0],
);
const activeLayout = computed(() => workbench.layouts[active.value.key]);

function switchWorkspace(key: string) {
  activeKey.value = key;
  localStorage.setItem(WORKSPACE_KEY, key);
}

// ---- Menu & accelerator actions ----

function refreshActive() {
  if (activeKey.value === "issues") void issues.refresh();
  else if (activeKey.value === "pulls") void pulls.refresh();
  else if (activeKey.value === "projects") void projectsStore.loadAll();
}

/**
 * Preferences opens the settings Editor in the active workspace — the same
 * mechanism as the panel-type dropdown (switch back there anytime). Uses
 * the workspace's first pane since there is no per-pane focus tracking.
 */
function openPreferences() {
  const leafId = workbench.firstLeafId(activeKey.value);
  if (leafId) workbench.setLeafPanel(leafId, "settings");
}

/** The URL the Tools menu works on: the selected issue/PR, else the repo. */
function currentGitHubUrl(): string | null {
  const selectedUrl = issues.selected?.url ?? pulls.selected?.url;
  if (selectedUrl) return selectedUrl;
  return origin.value ? `https://github.com/${origin.value}` : null;
}

function openInGithub() {
  const url = currentGitHubUrl();
  if (url) openExternalUrl(url);
}

async function copyGithubUrl() {
  const url = currentGitHubUrl();
  if (url) await navigator.clipboard.writeText(url);
}

const aboutOpen = ref(false);
const repoManagerOpen = ref(false);
const projectPickerOpen = ref(false);

// RepoManager 的 select：本地路径 / 仅远端 URL 都在此切换当前仓库。
function onRepoManagerSelect(target: string) {
  repo.setCurrent(target);
  repoManagerOpen.value = false;
}

// 跨工作区导航：看板卡片 → Issues（先切仓库上下文再选中），
// 状态栏项目格 → 项目工作区。消费后清空。
watch(
  () => projectsStore.navRequest,
  async (nav) => {
    if (!nav) return;
    projectsStore.navRequest = null;
    if (nav.workspace === "projects") {
      switchWorkspace("projects");
      return;
    }
    if (nav.repoId) {
      try {
        const rows = (await api.repoList()) as Array<{ id: string; path?: string | null; remoteUrl?: string | null }>;
        const row = rows.find((r) => r.id === nav.repoId);
        const target = row?.path ?? row?.remoteUrl;
        if (target && target !== repo.current) repo.setCurrent(target);
      } catch {
        // 仓库解析失败仍切工作区（保持当前上下文）
      }
      switchWorkspace(nav.workspace);
      if (nav.workspace === "issues" && nav.number) {
        try {
          await issues.refresh();
        } catch {
          // 刷新失败仍尝试选中本地缓存
        }
        issues.selectedNumber = nav.number;
      }
    }
  },
);

// 打开即登记：启动时把 lastRepo/recentRepos 导入 app.db（幂等）。
// 已不存在的路径（如 /tmp 清理）跳过——否则死路径每次启动都被重新登记。
async function importLegacyRepos() {
  if (!isTauri()) return;
  const legacy = [
    current.value,
    ...JSON.parse(localStorage.getItem("hivetask.recentRepos") ?? "[]") as string[],
  ].filter((p): p is string => !!p);
  const m = await import("./api");
  for (const path of [...new Set(legacy)]) {
    try {
      const info = await m.api.repoInfo(path);
      if (info.valid === false) continue;
      await m.api.repoRegister(path);
    } catch {
      // 单条导入失败不阻塞启动。
    }
  }
}

// Computed (not constant) so label language, checkmarks and disabled
// states stay live; every re-run is synced into the native menu inside
// Tauri (and re-rendered by AppMenu in the browser fallback).
const menus = computed(() =>
  buildMenuDefs({
    pickRepo: () => void repo.pick(),
    refresh: refreshActive,
    refreshDisabled: () => activeKey.value === "tools",
    openPreferences,
    gotoIssues: () => switchWorkspace("issues"),
    gotoPulls: () => switchWorkspace("pulls"),
    gotoProjects: () => switchWorkspace("projects"),
    gotoTools: () => switchWorkspace("tools"),
    statusbarVisible: () => settings.statusbarVisible,
    toggleStatusbar: () => settings.toggleStatusbar(),
    githubUrlMissing: () => currentGitHubUrl() === null,
    openInGithub,
    copyUrl: () => void copyGithubUrl(),
    openAbout: () => (aboutOpen.value = true),
  }),
);

watch(menus, (defs) => {
  if (inTauri) void syncApplicationMenu(defs, () => (aboutOpen.value = true));
}, { immediate: true });

// ---- Keyboard shortcuts (the menu accelerators, AppMenu is click-only) ----

function onKeydown(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  const plain: Record<string, () => void> = {
    o: () => void repo.pick(),
    r: refreshActive,
    "1": () => switchWorkspace("issues"),
    "2": () => switchWorkspace("pulls"),
    "4": () => switchWorkspace("projects"),
    "3": () => switchWorkspace("tools"),
    ",": openPreferences,
  };
  // Shifted layer only, so ⌘C/⌘O stay the webview's native copy/open.
  const shifted: Record<string, () => void> = { o: openInGithub, c: () => void copyGithubUrl() };
  const handler = event.shiftKey ? shifted[key] : plain[key];
  if (handler) {
    event.preventDefault();
    handler();
  }
}

// Repo context changes (startup restore, folder picker, VITE_AUTO_REPO) pull
// both caches; each workspace keeps its own selection and state filter.
watch(
  () => repo.current,
  async (path) => {
    if (!path || !isTauri()) return;
    await Promise.all([issues.loadCache(), pulls.loadCache()]);
  },
  { immediate: true },
);

onMounted(async () => {
  if (!inTauri) window.addEventListener("keydown", onKeydown);
  if (!isTauri()) return;
  await repo.checkHealth();
  void importLegacyRepos();
  void probeNow(); // seed the status bar's online/offline cell
  await repo.refreshInfo();
  void projectsStore.loadAll(); // 应用级项目列表（状态栏分布格 + 头部切换器）

  // Dev affordance: VITE_AUTO_REPO=/path/to/repo loads and syncs a repo at
  // startup; it is only read from the Vite dev environment, never packaged.
  const autoRepo = import.meta.env.VITE_AUTO_REPO as string | undefined;
  if (autoRepo && !repo.current) {
    repo.setCurrent(autoRepo);
    if (activeKey.value === "pulls") {
      await pulls.refresh();
      if (pulls.pulls.length > 0) pulls.select(pulls.pulls[0]);
    } else {
      await issues.refresh();
      if (issues.issues.length > 0) issues.select(issues.issues[0]);
    }
  }
});
onBeforeUnmount(() => {
  if (!inTauri) window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark">⬡</span>
        <span class="brand-name">HiveTask</span>
      </div>

      <AppMenu v-if="!inTauri" :menus="menus" />

      <nav class="workspace-tabs">
        <button
          v-for="w in workspaces"
          :key="w.key"
          class="workspace-tab"
          :class="{ active: activeKey === w.key }"
          @click="switchWorkspace(w.key)"
        >
          {{ t(w.labelKey) }}
        </button>
      </nav>

      <div class="header-spacer"></div>

      <div v-if="activeKey === 'projects'" class="repo-box">
        <template v-if="projectsStore.selected">
          <span class="repo-path" :title="projectsStore.selected.displayName">
            {{ projectsStore.selected.displayName }}
          </span>
          <span v-if="projectsStore.selected.description" class="repo-origin">
            {{ projectsStore.selected.description }}
          </span>
          <!-- 本地项目未发布到任何平台 = 等同私有；平台项目绑定落地后换真实值 -->
          <span class="vis-badge" :title="t('project.visibilityTip')">
            <EditorIcon name="lock" />
            {{ t("visibility.private") }}
          </span>
        </template>
        <span v-else class="repo-hint">{{ t("app.projectNone") }}</span>
      </div>
      <div v-else class="repo-box">
        <template v-if="current">
          <span class="repo-path" :title="current">{{ current }}</span>
          <span v-if="origin" class="repo-origin" :title="origin">{{ shortOrigin(origin) }}</span>
          <span
            v-if="visibility"
            class="vis-badge"
            :title="t(visibility === 'private' ? 'repo.visibilityPrivate' : 'repo.visibilityPublic')"
          >
            <EditorIcon :name="visibility === 'private' ? 'lock' : 'unlock'" />
            {{ t(visibility === "private" ? "visibility.private" : "visibility.public") }}
          </span>
        </template>
        <span v-else class="repo-hint">{{ t("app.repoNone") }}</span>
      </div>

      <div class="header-actions">
        <button
          v-if="activeKey === 'projects'"
          class="header-btn"
          @click="projectPickerOpen = true"
        >
          {{ t("app.projectSwitch") }}
        </button>
        <button v-else class="header-btn" @click="repoManagerOpen = true">
          {{ current ? t("app.repoSwitch") : t("app.repoPick") }}
        </button>
        <button class="header-btn theme-btn" :title="t('theme.switch')" @click="cycleTheme()">
          {{ theme === "system" ? "◐" : resolvedTheme === "dark" ? "☾" : "☀" }}
        </button>
        <button
          class="header-btn gear-btn"
          :title="t('menu.preferences')"
          @click="openPreferences()"
        >
          <!-- Octicons gear-16 (MIT): the ⚙ glyph renders small/thin in text fonts. -->
          <svg class="gear-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294.016.257.016.515 0 .772-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z"/>
          </svg>
        </button>
      </div>
    </header>

    <div v-if="repo.ghAvailable === false" class="gh-warning">
      {{ t("app.ghMissing") }}
      <code>brew install gh &amp;&amp; gh auth login</code>
    </div>

    <main class="workbench">
      <WorkbenchNode :key="active.key" :node="activeLayout" />
    </main>

    <StatusBar v-if="settings.statusbarVisible" :workspace="activeKey" />

    <ToastHost />

    <div v-if="repoManagerOpen" class="repo-overlay" @click.self="repoManagerOpen = false">
      <div class="repo-panel">
        <div class="repo-panel-head">
          <span class="repo-panel-title">{{ t("app.repoSwitch") }}</span>
          <button class="repo-panel-close" @click="repoManagerOpen = false">✕</button>
        </div>
        <RepoManager @select="onRepoManagerSelect" />
      </div>
    </div>

    <div v-if="projectPickerOpen" class="repo-overlay" @click.self="projectPickerOpen = false">
      <div class="repo-panel">
        <div class="repo-panel-head">
          <span class="repo-panel-title">{{ t("app.projectSwitch") }}</span>
          <button class="repo-panel-close" @click="projectPickerOpen = false">✕</button>
        </div>
        <ProjectManager />
      </div>
    </div>

    <AboutDialog :open="aboutOpen" @close="aboutOpen = false" />
  </div>
</template>

<style scoped>
.repo-overlay {
  position: fixed;
  inset: 0;
  z-index: 210;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.repo-panel {
  width: 480px;
  max-width: calc(100vw - 40px);
  max-height: 70vh;
  overflow: auto;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 12px 14px;
}
.repo-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
}
.repo-panel-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}
.repo-panel-close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
}
.repo-panel-close:hover {
  color: var(--text);
}
</style>
<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-app);
}
.app-header {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 44px;
  padding: 0 14px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  flex: none;
}
.brand {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.brand-mark {
  color: var(--accent);
  font-size: 16px;
}
.brand-name {
  font-weight: 700;
  font-size: 14px;
}
.workspace-tabs {
  display: flex;
  gap: 2px;
  margin-left: 10px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 2px;
}
.workspace-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 5px;
  cursor: pointer;
}
.workspace-tab:hover {
  color: var(--text);
}
.workspace-tab.active {
  background: var(--bg-selected);
  color: var(--accent);
  font-weight: 600;
}
.header-spacer {
  flex: 1;
}
.repo-box {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.repo-path {
  font-size: 12px;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 3px 10px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repo-origin {
  font-size: 11px;
  color: var(--text-dim);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.repo-hint {
  font-size: 12px;
  color: var(--text-dim);
}
/* 头部可见性徽标：锁/开锁 + 短文字（状态栏与列表保持纯图标） */
.vis-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  line-height: 1;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-dim);
  white-space: nowrap;
  flex: none;
}
.vis-badge :deep(.editor-icon) {
  width: 11px;
  height: 11px;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.header-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 12px;
  padding: 4px 14px;
  border-radius: 6px;
  cursor: pointer;
}
.theme-btn {
  padding: 4px 10px;
}
.gear-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px 9px;
}
.gear-icon {
  display: block;
}
.header-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.gh-warning {
  flex: none;
  padding: 7px 14px;
  font-size: 12px;
  color: var(--danger);
  background: var(--danger-banner);
  border-bottom: 1px solid var(--danger-banner-border);
}
.gh-warning code {
  background: var(--danger-soft);
  padding: 1px 6px;
  border-radius: 4px;
}
.workbench {
  flex: 1;
  min-height: 0;
}
</style>
