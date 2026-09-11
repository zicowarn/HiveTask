import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isTauri } from "../api";
import { t } from "../i18n";
import type { Pull, PullState } from "../types";
import { useRepoStore } from "./repo";

export const usePullsStore = defineStore("pulls", () => {
  const pulls = ref<Pull[]>([]);
  const state = ref<PullState>("open");
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastSyncedAt = ref<string | null>(null);
  const cachedCount = ref<number | null>(null);
  const selectedNumber = ref<number | null>(null);
  // PR numbers whose full record (gh pr view) has been merged into the list.
  const detailedNumbers = ref<Set<number>>(new Set());
  const detailLoading = ref(false);

  function select(pull: Pull | null) {
    selectedNumber.value = pull ? pull.number : null;
  }

  // List rows carry only the minimal gh field set (body/labels/review
  // connections are too heavy for the list query). Selecting a row fetches
  // and merges the full record once per session.
  async function ensureDetail(pull: Pull) {
    select(pull);
    const repo = useRepoStore();
    if (!repo.current || !isTauri()) return;
    if (detailedNumbers.value.has(pull.number)) return;
    detailLoading.value = true;
    try {
      const full = await api.refreshPullDetail(repo.current, pull.number);
      const index = pulls.value.findIndex((p) => p.number === full.number);
      if (index >= 0) pulls.value[index] = full;
      detailedNumbers.value.add(full.number);
    } catch (e) {
      // Detail is an enhancement: keep showing the list row on failure.
      console.error("Failed to load pull request detail", e);
    } finally {
      detailLoading.value = false;
    }
  }

  const selected = computed(
    () => pulls.value.find((p) => p.number === selectedNumber.value) ?? null,
  );

  const count = computed(() => pulls.value.length);

  async function loadCache() {
    const repo = useRepoStore();
    if (!repo.current || !isTauri()) return;
    try {
      pulls.value = await api.listCachedPulls(repo.current, state.value);
      // Rows cached from an earlier gh pr view already carry the body.
      detailedNumbers.value = new Set(
        pulls.value.filter((p) => p.body).map((p) => p.number),
      );
      cachedCount.value = await api.cachedPullCount(repo.current, state.value);
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
      pulls.value = await api.refreshPulls(repo.current, state.value);
      cachedCount.value = pulls.value.length;
      // New list rows are minimal records; detail loads must be redone.
      detailedNumbers.value = new Set();
      lastSyncedAt.value = new Date().toLocaleTimeString();
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  async function setState(next: PullState) {
    state.value = next;
    await loadCache();
  }

  return {
    pulls,
    state,
    loading,
    error,
    lastSyncedAt,
    cachedCount,
    selectedNumber,
    detailLoading,
    selected,
    count,
    loadCache,
    refresh,
    setState,
    select,
    ensureDetail,
  };
});
