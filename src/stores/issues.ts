import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isTauri, type LabelInfo, type MilestoneInfo } from "../api";
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
  // 点击时的 issue 对象本体。store 的 issues 数组是列表模式的状态筛选集
  // （里程碑 mode 的 Issue 不一定在里面），编号解析失败时用它兜底。
  const selectedIssue = ref<Issue | null>(null);
  // 里程碑选中（里程碑模式组头单击设置）：右栏据此派生渲染里程碑详情，
  // 与 issue 选中互斥——同一时刻详情面板只服务一个主体。
  const selectedMilestone = ref<string | null>(null);
  // Conversation of the selected issue; pending rows are optimistic adds.
  const comments = ref<Comment[]>([]);
  const commentsLoading = ref(false);
  const commentSubmitting = ref(false);
  const stateWorking = ref(false);

  function select(issue: Issue | null) {
    selectedNumber.value = issue ? issue.number : null;
    selectedIssue.value = issue;
    if (issue) selectedMilestone.value = null;
  }

  /** 选中里程碑（title 为 null = 清除）。选 issue 走 select()，两边互斥。 */
  function selectMilestone(title: string | null) {
    selectedMilestone.value = title;
    if (title !== null) selectedNumber.value = null;
  }

  const selected = computed(() =>
    // 数组命中优先（列表模式，随刷新保持新鲜）；不在数组里（如里程碑
    // mode 点开的 Issue）退回点击时的对象本体。
    issues.value.find((i) => i.number === selectedNumber.value) ??
      (selectedIssue.value?.number === selectedNumber.value ? selectedIssue.value : null)
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

  /** 创建 Issue（写穿透）：新实体插列表顶部；失败落 store.error 由调用方展示。 */
  async function createIssue(
    title: string,
    body?: string,
    milestone?: string,
    labels?: string[],
    assignees?: string[],
  ) {
    const repo = useRepoStore();
    if (!repo.current || !isTauri()) return;
    loading.value = true;
    error.value = null;
    try {
      const fresh = await api.createIssue(repo.current, title, body, milestone, labels, assignees);
      issues.value = [fresh, ...issues.value];
      cachedCount.value = (cachedCount.value ?? 0) + 1;
      setOnline(true);
    } catch (e) {
      error.value = translateError(String(e));
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
    // 里程碑 mode 点开的 Issue 不在数组里，选中对象本体也要同步，
    // 否则详情页的关闭/重开按钮状态会滞留。
    if (selectedIssue.value?.number === number) {
      selectedIssue.value = { ...selectedIssue.value, state: stateValue };
    }
  }

  /** 编辑标题/正文（写穿透：成功 → 全量回填 store + 选中对象；失败抛给
   * 详情编辑态——表单留在现场，内容不丢，重试 = 再点一次保存）。 */
  async function updateIssue(number: string, title: string, body?: string) {
    const repo = useRepoStore();
    if (!repo.current || !isTauri()) {
      throw new Error(t("error.browserPreview"));
    }
    const fresh = await api.updateIssue(repo.current, number, title, body);
    patchIssue(fresh);
  }

  /** 新鲜实体落地：数组命中则原位替换，否则回填选中对象本体。 */
  function patchIssue(fresh: Issue) {
    const idx = issues.value.findIndex((i) => i.number === fresh.number);
    if (idx >= 0) issues.value.splice(idx, 1, fresh);
    if (selectedIssue.value?.number === fresh.number) selectedIssue.value = fresh;
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
      const fresh = await api.setIssueState(repo.current, issue.number, closed, closed ? "completed" : null);
      patchState(fresh.number, fresh.state);
    } catch (e) {
      patchState(issue.number, previous);
      reportError(String(e));
    } finally {
      stateWorking.value = false;
    }
  }

  // ---- 里程碑元数据（远端口径，每仓库缓存）----
  // 组头与里程碑详情共享同一份：远端调用只发生在首次加载和手动刷新，
  // 点组头出详情是同步读取，不再每次点击都打 gh api。
  const milestones = ref<MilestoneInfo[]>([]);
  const milestonesRepo = ref<string | null>(null);
  const milestonesLoading = ref(false);

  /** force = 跳过缓存强制重拉（里程碑 mode 的刷新语义）。 */
  async function loadMilestones(repo: string, force = false) {
    if (!force && milestonesRepo.value === repo && milestones.value.length > 0) return;
    milestonesLoading.value = true;
    try {
      milestones.value = await api.milestoneList(repo);
      milestonesRepo.value = repo;
    } finally {
      milestonesLoading.value = false;
    }
  }

  /** 写穿透结果落地：按平台编号原位替换（组头/详情共享响应式更新）。 */
  function patchMilestone(fresh: MilestoneInfo) {
    const idx = milestones.value.findIndex((m) => m.number === fresh.number);
    if (idx >= 0) milestones.value.splice(idx, 1, fresh);
  }

  /** 关闭/重开里程碑（失败抛给调用方：详情按钮处提示，状态不变）。 */
  async function setMilestoneState(m: MilestoneInfo, closed: boolean) {
    const repo = useRepoStore();
    if (!repo.current || !isTauri()) throw new Error(t("error.browserPreview"));
    patchMilestone(await api.setMilestoneState(repo.current, m.number, closed));
  }

  /** 编辑里程碑名称/描述/截止日（写穿透），返回平台确认的全量元数据。 */
  async function updateMilestone(m: MilestoneInfo, title: string, description?: string, dueOn?: string): Promise<MilestoneInfo> {
    const repo = useRepoStore();
    if (!repo.current || !isTauri()) throw new Error(t("error.browserPreview"));
    const fresh = await api.updateMilestone(repo.current, m.number, title, description, dueOn);
    patchMilestone(fresh);
    return fresh;
  }

  // ---- 标签目录（每仓库缓存，选择器与列表/详情着色共享）----
  const labels = ref<LabelInfo[]>([]);
  const labelsRepo = ref<string | null>(null);

  /** force = 跳过缓存强制重拉。 */
  async function loadLabels(repo: string, force = false) {
    if (!force && labelsRepo.value === repo && labels.value.length > 0) return;
    labels.value = await api.labelList(repo);
    labelsRepo.value = repo;
  }

  /** 新建标签（写穿透）：成功追加进目录并返回，供自动勾选。 */
  async function addLabel(name: string, color: string): Promise<LabelInfo> {
    const repo = useRepoStore();
    if (!repo.current || !isTauri()) throw new Error(t("error.browserPreview"));
    const fresh = await api.createLabel(repo.current, name, color);
    labels.value = [...labels.value, fresh];
    return fresh;
  }

  /** 标签名 → 主题色（hex，可能缺 # 前缀）；目录未含/未加载 → null。 */
  function labelColor(name: string): string | null {
    return labels.value.find((l) => l.name === name)?.color ?? null;
  }

  return {
    issues,
    state,
    loading,
    error,
    cachedCount,
    selectedNumber,
    selectedMilestone,
    selected,
    count,
    comments,
    commentsLoading,
    commentSubmitting,
    stateWorking,
    loadCache,
    refresh,
    createIssue,
    updateIssue,
    setState,
    select,
    selectMilestone,
    milestones,
    milestonesRepo,
    milestonesLoading,
    loadMilestones,
    setMilestoneState,
    updateMilestone,
    labels,
    loadLabels,
    addLabel,
    labelColor,
    clearComments,
    loadComments,
    addComment,
    setClosed,
  };
});
