<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import WorkbenchNode from "./workbench/WorkbenchNode.vue";
import { workspaces } from "./workbench/registry";
import { api, isTauri } from "./api";
import { useRepoStore } from "./stores/repo";
import { useIssuesStore } from "./stores/issues";
import { usePullsStore } from "./stores/pulls";
import { useWorkbenchStore } from "./stores/workbench";
import type { HealthInfo } from "./types";

const WORKSPACE_KEY = "hivetask.workspace";

const repo = useRepoStore();
const issues = useIssuesStore();
const pulls = usePullsStore();
const workbench = useWorkbenchStore();
const { current, origin } = storeToRefs(repo);

const health = ref<HealthInfo | null>(null);

const activeKey = ref(localStorage.getItem(WORKSPACE_KEY) ?? "issues");
const active = computed(
  () => workspaces.find((w) => w.key === activeKey.value) ?? workspaces[0],
);
const activeLayout = computed(() => workbench.layouts[active.value.key]);

function switchWorkspace(key: string) {
  activeKey.value = key;
  localStorage.setItem(WORKSPACE_KEY, key);
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
  if (!isTauri()) return;
  health.value = await api.healthCheck();
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
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark">⬡</span>
        <span class="brand-name">HiveTask</span>
      </div>

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
        <span v-else class="repo-hint">未选择仓库</span>
      </div>

      <div class="header-actions">
        <button class="header-btn" @click="repo.pick()">
          {{ current ? "切换仓库" : "选择仓库" }}
        </button>
      </div>
    </header>

    <div v-if="health && !health.ghAvailable" class="gh-warning">
      未检测到 gh CLI。请先安装并完成登录：
      <code>brew install gh &amp;&amp; gh auth login</code>
    </div>

    <main class="workbench">
      <WorkbenchNode :key="active.key" :node="activeLayout" />
    </main>
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
.header-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 12px;
  padding: 4px 14px;
  border-radius: 6px;
  cursor: pointer;
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
  background: rgba(248, 113, 113, 0.08);
  border-bottom: 1px solid rgba(248, 113, 113, 0.25);
}
.gh-warning code {
  background: rgba(248, 113, 113, 0.12);
  padding: 1px 6px;
  border-radius: 4px;
}
.workbench {
  flex: 1;
  min-height: 0;
}
</style>
