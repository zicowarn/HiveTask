import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isTauri } from "../api";
import { t } from "../i18n";
import { isNetworkError, reportError, translateError } from "../gh-errors";
import { pushToast } from "../toast";
import { setOnline } from "../net";
import type { Comment, Issue, IssueState } from "../types";
import { useRepoStore } from "./repo";
import { useSyncMetaStore } from "./sync-meta";

export const useIssuesStore = defineStore("issues", () => {
  const issues = ref<Issue[]>([]);
  const state = ref<IssueState>("open");
  const loading = ref(false);
  const error = ref<string | null>(null);
  const cachedCount = ref<number | null>(null);
  const selectedNumber = ref<string | null>(null);
  // Conversation of the selected issue; pending rows are optimistic adds.
  const comments = ref<Comment[]>([]);
  const commentsLoading = ref(false);
  const commentSubmitting = ref(false);
  const stateWorking = ref(false);

  function select(issue: Issue | null) {
    selectedNumber.value = issue ? issue.number : null;
  }

  const selected = computed(() =>
    issues.value.find((i) => i.number === selectedNumber.value) ?? null
  );

  const count = computed(() => issues.value.length);

  async function loadCache() {
    const repo = useRepoStore();
    // 启动探针会在 await 间隙把失效的 current 清成 null（如 /tmp 腐掉的
    // 登记），这里必须快照，否则第二次调用把 null 传进 invoke。
    const path = repo.current;
    if (!path || !isTauri()) return;
    try {
      issues.value = await api.listCachedIssues(path, state.value);
      if (repo.current !== path) return; // 已切换仓库，旧结果不落地
      cachedCount.value = await api.cachedIssueCount(path, state.value);
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
      issues.value = await api.refreshIssues(repo.current, state.value);
      cachedCount.value = issues.value.length;
      useSyncMetaStore().stamp(`issues:${state.value}`);
      setOnline(true);
    } catch (e) {
      error.value = translateError(String(e));
      setOnline(!isNetworkError(String(e)));
    } finally {
      loading.value = false;
    }
  }

  async function setState(next: IssueState) {
    state.value = next;
    await loadCache();
  }

  // ---- Conversation (write-through) ----

  function clearComments() {
    comments.value = [];
  }

  /** Cache-first paint, then reconcile with GitHub. Guards against races:
   * only the currently selected issue may land in `comments`. */
  async function loadComments(number: string) {
    const repo = useRepoStore();
    const path = repo.current; // 同 loadCache：await 后 current 可能已被探针清空
    if (!path || !isTauri()) return;
    commentsLoading.value = true;
    try {
      const cached = await api.listCachedComments(path, "issue", number);
      if (selectedNumber.value === number) comments.value = cached;
      const fresh = await api.fetchComments(path, "issue", number);
      if (selectedNumber.value === number) comments.value = fresh;
    } catch (e) {
      error.value = translateError(String(e));
    } finally {
      commentsLoading.value = false;
    }
  }

  /** Optimistic pending row → gh post → replace with the fresh conversation;
   * any failure drops the pending row and surfaces the error. */
  async function addComment(number: string, body: string) {
    const repo = useRepoStore();
    if (!repo.current) return;
    if (!isTauri()) {
      pushToast({ kind: "info", message: t("error.browserPreview") });
      return;
    }
    commentSubmitting.value = true;
    comments.value.push({ body, pending: true });
    try {
      const fresh = await api.addComment(repo.current, "issue", number, body);
      if (selectedNumber.value === number) comments.value = fresh;
    } catch (e) {
      comments.value = comments.value.filter((c) => !c.pending);
      reportError(String(e));
    } finally {
      commentSubmitting.value = false;
    }
  }

  function patchState(number: string, stateValue: string) {
    const target = issues.value.find((i) => i.number === number);
    if (target) target.state = stateValue;
  }

  /** Optimistic state flip → gh → patch the store from the fresh entity. */
  async function setClosed(issue: Issue, closed: boolean) {
    const repo = useRepoStore();
    if (!repo.current) return;
    if (!isTauri()) {
      pushToast({ kind: "info", message: t("error.browserPreview") });
      return;
    }
    stateWorking.value = true;
    const previous = issue.state;
    patchState(issue.number, closed ? "CLOSED" : "OPEN");
    try {
      const fresh = await api.setIssueState(repo.current, issue.number, closed);
      patchState(fresh.number, fresh.state);
    } catch (e) {
      patchState(issue.number, previous);
      reportError(String(e));
    } finally {
      stateWorking.value = false;
    }
  }

  return {
    issues,
    state,
    loading,
    error,
    cachedCount,
    selectedNumber,
    selected,
    count,
    comments,
    commentsLoading,
    commentSubmitting,
    stateWorking,
    loadCache,
    refresh,
    setState,
    select,
    clearComments,
    loadComments,
    addComment,
    setClosed,
  };
});
