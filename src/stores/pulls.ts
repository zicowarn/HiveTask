import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isTauri } from "../api";
import { t } from "../i18n";
import { isNetworkError, reportError, translateError } from "../gh-errors";
import { pushToast } from "../toast";
import { setOnline } from "../net";
import type { Comment, Pull, PullState } from "../types";
import { useRepoStore } from "./repo";
import { useSyncMetaStore } from "./sync-meta";

export const usePullsStore = defineStore("pulls", () => {
  const pulls = ref<Pull[]>([]);
  const state = ref<PullState>("open");
  const loading = ref(false);
  const error = ref<string | null>(null);
  const cachedCount = ref<number | null>(null);
  const selectedNumber = ref<number | null>(null);
  // PR numbers whose full record (gh pr view) has been merged into the list.
  const detailedNumbers = ref<Set<number>>(new Set());
  const detailLoading = ref(false);
  // Conversation of the selected PR; pending rows are optimistic adds.
  const comments = ref<Comment[]>([]);
  const commentsLoading = ref(false);
  const commentSubmitting = ref(false);
  const stateWorking = ref(false);
  const mergeWorking = ref(false);

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
      error.value = translateError(String(e));
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
      useSyncMetaStore().stamp(`pulls:${state.value}`);
      setOnline(true);
    } catch (e) {
      error.value = translateError(String(e));
      setOnline(!isNetworkError(String(e)));
    } finally {
      loading.value = false;
    }
  }

  async function setState(next: PullState) {
    state.value = next;
    await loadCache();
  }

  // ---- Conversation (write-through) ----

  function clearComments() {
    comments.value = [];
  }

  /** Cache-first paint, then reconcile with GitHub; only the currently
   * selected PR may land in `comments`. */
  async function loadComments(number: number) {
    const repo = useRepoStore();
    if (!repo.current || !isTauri()) return;
    commentsLoading.value = true;
    try {
      const cached = await api.listCachedComments(repo.current, "pull", String(number));
      if (selectedNumber.value === number) comments.value = cached;
      const fresh = await api.fetchComments(repo.current, "pull", String(number));
      if (selectedNumber.value === number) comments.value = fresh;
    } catch (e) {
      error.value = translateError(String(e));
    } finally {
      commentsLoading.value = false;
    }
  }

  /** Optimistic pending row → gh post → replace with the fresh conversation. */
  async function addComment(number: number, body: string) {
    const repo = useRepoStore();
    if (!repo.current) return;
    if (!isTauri()) {
      pushToast({ kind: "info", message: t("error.browserPreview") });
      return;
    }
    commentSubmitting.value = true;
    comments.value.push({ body, pending: true });
    try {
      const fresh = await api.addComment(repo.current, "pull", String(number), body);
      if (selectedNumber.value === number) comments.value = fresh;
    } catch (e) {
      comments.value = comments.value.filter((c) => !c.pending);
      reportError(String(e));
    } finally {
      commentSubmitting.value = false;
    }
  }

  /** Optimistic state flip → gh → patch the store from the fresh full
   * record (a close that raced a merge lands as MERGED). */
  async function setClosed(pull: Pull, closed: boolean) {
    const repo = useRepoStore();
    if (!repo.current) return;
    if (!isTauri()) {
      pushToast({ kind: "info", message: t("error.browserPreview") });
      return;
    }
    stateWorking.value = true;
    const previous = pull.state;
    patchState(pull.number, closed ? "CLOSED" : "OPEN");
    try {
      const fresh = await api.setPullState(repo.current, pull.number, closed);
      const index = pulls.value.findIndex((p) => p.number === fresh.number);
      if (index >= 0) pulls.value[index] = fresh;
      detailedNumbers.value.add(fresh.number);
    } catch (e) {
      patchState(pull.number, previous);
      reportError(String(e));
    } finally {
      stateWorking.value = false;
    }
  }

  /** Merge is irreversible and slow: NO optimistic flip — the working
   * flag spans the roundtrip; success patches from the fresh full record
   * (state MERGED), failure toasts via reportError. */
  async function merge(pull: Pull, method: "merge" | "squash" | "rebase") {
    const repo = useRepoStore();
    if (!repo.current) return;
    if (!isTauri()) {
      pushToast({ kind: "info", message: t("error.browserPreview") });
      return;
    }
    mergeWorking.value = true;
    try {
      const fresh = await api.mergePull(repo.current, pull.number, method);
      const index = pulls.value.findIndex((p) => p.number === fresh.number);
      if (index >= 0) pulls.value[index] = fresh;
      detailedNumbers.value.add(fresh.number);
    } catch (e) {
      reportError(String(e));
    } finally {
      mergeWorking.value = false;
    }
  }

  function patchState(number: number, stateValue: string) {
    const target = pulls.value.find((p) => p.number === number);
    if (target) target.state = stateValue;
  }

  return {
    pulls,
    state,
    loading,
    error,
    cachedCount,
    selectedNumber,
    detailLoading,
    selected,
    count,
    comments,
    commentsLoading,
    commentSubmitting,
    stateWorking,
    mergeWorking,
    merge,
    loadCache,
    refresh,
    setState,
    select,
    ensureDetail,
    clearComments,
    loadComments,
    addComment,
    setClosed,
  };
});
