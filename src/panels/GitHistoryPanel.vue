<script setup lang="ts">
/**
 * Git history panel — commit graph across all local + remote tips (git2
 * data, @web-git-graph rendering), a branch strip with ahead/behind
 * badges, and a Fetch button that shells out to `git fetch` (credential
 * helpers stay with the user's git).
 */
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import { useRepoStore } from "../stores/repo";
import { api, isTauri } from "../api";
import { useI18n } from "../i18n";
import { useTheme } from "../theme";
import { translateError } from "../gh-errors";
import "@web-git-graph/web/register";
import type { GitBranchRow, GitHistoryPage } from "../types";

defineProps<{ leafId?: string; panelType?: string }>();

const repo = useRepoStore();
const { current } = storeToRefs(repo);
const { t } = useI18n();
const { resolvedTheme } = useTheme();

const history = ref<GitHistoryPage | null>(null);
const branches = ref<GitBranchRow[]>([]);
const loading = ref(false);
const fetching = ref(false);
const error = ref<string | null>(null);
/** null = walk every tip; a branch name filters the graph to it. */
const selectedRef = ref<string | null>(null);

async function load() {
  if (!current.value || !isTauri()) return;
  loading.value = true;
  error.value = null;
  try {
    const [historyPage, branchRows] = await Promise.all([
      api.gitHistory(current.value),
      api.gitBranches(current.value),
    ]);
    history.value = historyPage;
    branches.value = branchRows.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  } catch (e) {
    error.value = translateError(String(e));
  } finally {
    loading.value = false;
  }
}

async function fetchAll() {
  if (!current.value || fetching.value) return;
  fetching.value = true;
  try {
    await api.gitFetch(current.value);
    await load();
  } catch (e) {
    error.value = translateError(String(e));
  } finally {
    fetching.value = false;
  }
}

watch(current, () => void load(), { immediate: true });

/** The renderer's DTO wants ISO dates; Rust sends unix seconds. */
const graphPage = computed(() => {
  if (!history.value) return null;
  return {
    commits: history.value.commits.map((c) => ({
      kind: "commit" as const,
      oid: c.oid,
      parents: c.parents,
      message: c.message,
      author: c.author ? { name: c.author } : undefined,
      committedAt: new Date(c.committedAtUnix * 1000).toISOString(),
    })),
    refs: history.value.refs,
    head: history.value.head ?? undefined,
    hasMore: false,
  };
});

function pickRef(name: string) {
  selectedRef.value = selectedRef.value === name ? null : name;
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template #actions>
      <button class="fetch-btn" :disabled="fetching || loading" @click="fetchAll">
        {{ fetching ? t("common.syncing") : t("gitHistory.fetch") }}
      </button>
    </template>

    <p v-if="error" class="error-banner">{{ error }}</p>

    <div v-if="branches.length" class="branch-strip">
      <button
        v-for="branch in branches"
        :key="branch.name"
        class="branch-chip"
        :class="{ current: branch.isCurrent, remote: branch.isRemote, picked: selectedRef === branch.name }"
        :title="t('gitHistory.clickToFilter')"
        @click="pickRef(branch.name)"
      >
        {{ branch.name }}
        <span
          v-if="!branch.isRemote && (branch.ahead || branch.behind)"
          class="ab-badge"
          :title="t('gitHistory.aheadBehind', { ahead: branch.ahead, behind: branch.behind })"
        >
          ↑{{ branch.ahead }} ↓{{ branch.behind }}
        </span>
      </button>
    </div>

    <div class="graph-wrap">
      <p v-if="loading" class="graph-note">{{ t("common.loadingFull") }}</p>
      <p v-else-if="error" class="graph-note">{{ error }}</p>
      <p v-else-if="history && history.commits.length === 0" class="graph-note">
        {{ t("gitHistory.noCommits") }}
      </p>
      <web-git-graph
        v-else-if="graphPage"
        class="graph"
        :data.prop="graphPage"
        :refs.prop="selectedRef ? [selectedRef] : []"
        :theme.prop="resolvedTheme"
        columns="date,author"
      ></web-git-graph>
    </div>
  </PanelShell>
</template>

<style scoped>
.fetch-btn {
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
.fetch-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.fetch-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.error-banner {
  margin: 8px 14px 0;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
}
.branch-strip {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
}
.branch-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text-dim);
  font-size: 11px;
  height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  cursor: pointer;
  white-space: nowrap;
}
.branch-chip:hover {
  color: var(--text);
}
.branch-chip.current {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.branch-chip.remote {
  border-style: dashed;
}
.branch-chip.picked {
  background: var(--bg-selected);
  color: var(--accent);
}
.ab-badge {
  font-size: 10px;
  color: var(--warning);
}
/* The element is a virtualized list — it requires a definite height. */
.graph-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
}
.graph {
  flex: 1;
  height: 100%;
}
.graph-note {
  margin: auto;
  color: var(--text-dim);
  font-size: 12px;
}
</style>
