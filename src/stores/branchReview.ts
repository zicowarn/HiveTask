/**
 * Branch review store — the local-shape PR flow for repos without a remote
 * platform (platform === "local"). Selection state mirrors the pulls store:
 * the list panel picks a branch, the detail panel shows diff + merge.
 * base 分支按 repo 记忆（localStorage），默认 main → master → 首个分支。
 */
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { api, isTauri, type BranchReviewDiff, type ReviewBranch } from "../api";
import { useRepoStore } from "./repo";

const baseKey = (repo: string) => `hivetask.branchreview.base.${repo}`;

export const useBranchReviewStore = defineStore("branch-review", () => {
  const branches = ref<ReviewBranch[]>([]);
  const base = ref<string | null>(null);
  const selected = ref<string | null>(null);
  const diff = ref<BranchReviewDiff | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const repoStore = useRepoStore();

  const isLocal = computed(() => repoStore.platform === "local");

  /** 可选 base：除当前选中分支外的本地分支（main 优先已在后端排序兜底）。 */
  const baseChoices = computed(() => branches.value.map((b) => b.name));

  async function loadBranches() {
    const repo = repoStore.current;
    if (!repo || !isTauri() || !isLocal.value) {
      branches.value = [];
      return;
    }
    // 先取全量本地分支（现成 gitBranches），定 base，再拉计数
    const rows = await api.gitBranches(repo);
    const names = rows.filter((r) => !r.isRemote).map((r) => r.name);
    const saved = localStorage.getItem(baseKey(repo));
    const valid = (n: string | null) => (n && names.includes(n) ? n : null);
    base.value =
      valid(saved) ??
      valid(names.find((n) => n === "main") ?? null) ??
      valid(names.find((n) => n === "master") ?? null) ??
      names[0] ??
      null;
    if (base.value) localStorage.setItem(baseKey(repo), base.value);
    try {
      branches.value = base.value
        ? (await api.branchReviewList(repo, base.value)).filter((b) => b.name !== base.value)
        : [];
    } catch {
      branches.value = [];
    }
    // 选中分支失效清理
    if (selected.value && !branches.value.some((b) => b.name === selected.value)) {
      selected.value = null;
      diff.value = null;
    }
  }

  async function setBase(name: string) {
    base.value = name;
    const repo = repoStore.current;
    if (repo) localStorage.setItem(baseKey(repo), name);
    if (selected.value === name) {
      selected.value = null;
      diff.value = null;
    }
    await loadBranches();
  }

  async function select(name: string) {
    selected.value = name;
    await loadDiff();
  }

  async function loadDiff() {
    const repo = repoStore.current;
    if (!repo || !isTauri() || !selected.value || !base.value) {
      diff.value = null;
      return;
    }
    loading.value = true;
    error.value = null;
    try {
      diff.value = await api.branchReviewDiff(repo, base.value, selected.value);
    } catch (e) {
      error.value = String(e);
      diff.value = null;
    } finally {
      loading.value = false;
    }
  }

  async function merge(method: "merge" | "squash" | "rebase") {
    const repo = repoStore.current;
    if (!repo || !selected.value || !base.value) return;
    loading.value = true;
    error.value = null;
    try {
      await api.branchMerge(repo, base.value, selected.value, method);
      await loadBranches();
      await loadDiff();
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  async function removeBranch(name: string, force: boolean) {
    const repo = repoStore.current;
    if (!repo) return;
    await api.branchDelete(repo, name, force);
    if (selected.value === name) {
      selected.value = null;
      diff.value = null;
    }
    await loadBranches();
  }

  function clear() {
    branches.value = [];
    selected.value = null;
    diff.value = null;
    base.value = null;
    error.value = null;
  }

  watch(
    () => [repoStore.current, repoStore.platform] as const,
    () => {
      if (!isLocal.value) clear();
      else void loadBranches();
    },
    { immediate: false },
  );

  return {
    branches,
    base,
    baseChoices,
    selected,
    diff,
    loading,
    error,
    isLocal,
    loadBranches,
    setBase,
    select,
    merge,
    removeBranch,
    clear,
  };
});
