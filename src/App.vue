<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import WorkbenchNode from "./workbench/WorkbenchNode.vue";
import StatusBar from "./workbench/StatusBar.vue";
import AppMenu from "./components/AppMenu.vue";
import AboutDialog from "./components/AboutDialog.vue";
import { workspaces } from "./workbench/registry";
import { buildMenuDefs } from "./menu-defs";
import { syncApplicationMenu } from "./native-menu";
import { openExternalUrl } from "./open-url";
import { isTauri } from "./api";
import { useRepoStore } from "./stores/repo";
import { useIssuesStore } from "./stores/issues";
import { usePullsStore } from "./stores/pulls";
import { useSettingsStore } from "./stores/settings";
import { useWorkbenchStore } from "./stores/workbench";
import { useI18n } from "./i18n";
import { useTheme } from "./theme";

const WORKSPACE_KEY = "hivetask.workspace";

const repo = useRepoStore();
const issues = useIssuesStore();
const pulls = usePullsStore();
const settings = useSettingsStore();
const workbench = useWorkbenchStore();
const { current, origin } = storeToRefs(repo);
const { t, locale, toggleLocale } = useI18n();
const { resolvedTheme, toggleTheme } = useTheme();

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

// Computed (not constant) so label language, checkmarks and disabled
// states stay live; every re-run is synced into the native menu inside
// Tauri (and re-rendered by AppMenu in the browser fallback).
const menus = computed(() =>
  buildMenuDefs({
    pickRepo: () => void repo.pick(),
    refresh: refreshActive,
    refreshDisabled: () => activeKey.value === "settings",
    openPreferences,
    gotoIssues: () => switchWorkspace("issues"),
    gotoPulls: () => switchWorkspace("pulls"),
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
  await repo.refreshInfo();

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
          {{ w.label }}
        </button>
      </nav>

      <div class="header-spacer"></div>

      <div class="repo-box">
        <template v-if="current">
          <span class="repo-path" :title="current">{{ current }}</span>
          <span v-if="origin" class="repo-origin" :title="origin">{{ origin }}</span>
        </template>
        <span v-else class="repo-hint">{{ t("app.repoNone") }}</span>
      </div>

      <div class="header-actions">
        <button class="header-btn" @click="repo.pick()">
          {{ current ? t("app.repoSwitch") : t("app.repoPick") }}
        </button>
        <button class="header-btn theme-btn" :title="t('theme.switch')" @click="toggleTheme()">
          {{ resolvedTheme === "dark" ? "☀" : "☾" }}
        </button>
        <button class="header-btn lang-btn" :title="t('lang.switch')" @click="toggleLocale()">
          {{ locale === "zh-CN" ? "EN" : "中文" }}
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

    <AboutDialog :open="aboutOpen" @close="aboutOpen = false" />
  </div>
</template>

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
.lang-btn,
.theme-btn {
  padding: 4px 10px;
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
