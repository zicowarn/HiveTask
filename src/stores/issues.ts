import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isTauri } from "../api";
import { t } from "../i18n";
import type { Issue, IssueState } from "../types";
import { useRepoStore } from "./repo";

export const useIssuesStore = defineStore("issues", () => {
  const issues = ref<Issue[]>([]);
  const state = ref<IssueState>("open");
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastSyncedAt = ref<string | null>(null);
  const cachedCount = ref<number | null>(null);
  const selectedNumber = ref<number | null>(null);

  function select(issue: Issue | null) {
    selectedNumber.value = issue ? issue.number : null;
  }

  const selected = computed(() =>
    issues.value.find((i) => i.number === selectedNumber.value) ?? null
  );

  const count = computed(() => issues.value.length);

  async function loadCache() {
    const repo = useRepoStore();
    if (!repo.current || !isTauri()) return;
    try {
      issues.value = await api.listCachedIssues(repo.current, state.value);
      cachedCount.value = await api.cachedIssueCount(repo.current, state.value);
    } catch (e) {
      error.value = String(e);
    }
  }

  async function refresh() {
    const repo = useRepoStore();
    if (!repo.current) return;
    if (!isTauri()) {
      error.value = t("error.browserPreview");
      return;
    }
    loading.value = true;
    error.value = null;
    try {
      issues.value = await api.refreshIssues(repo.current, state.value);
      cachedCount.value = issues.value.length;
      lastSyncedAt.value = new Date().toLocaleTimeString();
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  async function setState(next: IssueState) {
    state.value = next;
    await loadCache();
  }

  return {
    issues,
    state,
    loading,
    error,
    lastSyncedAt,
    cachedCount,
    selectedNumber,
    selected,
    count,
    loadCache,
    refresh,
    setState,
    select,
  };
});
