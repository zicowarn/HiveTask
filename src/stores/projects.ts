/**
 * Projects board store — application-level (unlike issue/pull stores it
 * does NOT follow repo switches; the board is the cross-repo view).
 * The Rust side owns the truth (app.db); this store is a loadable cache.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, type BoundRepo, type FieldOption, type Project, type ProjectField, type ProjectItem } from "../api";
import { isTauri } from "../api";

export const useProjectsStore = defineStore("projects", () => {
  const projects = ref<Project[]>([]);
  const selectedId = ref<string | null>(null);
  const fields = ref<ProjectField[]>([]);
  const items = ref<ProjectItem[]>([]);
  const boundRepos = ref<BoundRepo[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** 跨工作区导航请求（看板卡片 → Issues；状态栏 → 项目工作区）。
   * repoId = 登记表 id，App.vue 消费时解析成 path/URL target。 */
  const navRequest = ref<{ workspace: string; repoId?: string; number?: string } | null>(null);

  // ---- 视图工具栏（对齐 GitHub Projects：左筛选 + ⚙ 视图设置）----
  const VIEW_KEY = "hivetask.panel-view.project.board";
  const filterText = ref(localStorage.getItem(`${VIEW_KEY}.filter`) ?? "");
  type SortBy = "manual" | "priority" | "added";
  const sortBy = ref<SortBy>(
    (localStorage.getItem(`${VIEW_KEY}.sort`) as SortBy | null) ?? "manual",
  );
  function setSortBy(v: SortBy) {
    sortBy.value = v;
    localStorage.setItem(`${VIEW_KEY}.sort`, v);
  }

  interface FilterTokens {
    text: string;
    status: string[];
    priority: string[];
  }
  /** 解析 `status:xxx priority:yyy 自由文本`（空格分隔，冒号后整段为一个值，
   * 含空格的值用引号）。未识别的 aaa:bbb 按自由文本处理。 */
  function parseFilter(raw: string, statusNames: string[], priorityNames: string[]): FilterTokens {
    const tokens: FilterTokens = { text: "", status: [], priority: [] };
    for (const part of raw.split(/\s+/).filter(Boolean)) {
      const m = part.match(/^(status|priority):(.+)$/i);
      if (!m) {
        tokens.text += (tokens.text ? " " : "") + part;
        continue;
      }
      const kind = m[1]!.toLowerCase();
      const needle = m[2]!.replace(/^"|"$/g, "").toLowerCase();
      const pool = kind === "status" ? statusNames : priorityNames;
      if (pool.some((n) => n.toLowerCase().includes(needle))) {
        (kind === "status" ? tokens.status : tokens.priority).push(needle);
      } else {
        tokens.text += (tokens.text ? " " : "") + part;
      }
    }
    return tokens;
  }

  /** 过滤 + 排序后的条目（Board/Table 两种投影共用）。 */
  const filteredItems = computed(() => {
    const statusF = fields.value.find((f) => f.kind === "builtin_status") ?? null;
    const prioF = fields.value.find((f) => f.name === "优先级") ?? null;
    const tokens = parseFilter(
      filterText.value,
      statusF?.options.map((o) => o.name) ?? [],
      prioF?.options.map((o) => o.name) ?? [],
    );
    const optionIndex = (field: ProjectField | null, item: ProjectItem): number => {
      if (!field) return -1;
      const v = item.fieldValues[field.id];
      const idx = field.options.findIndex((o) => o.id === v);
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };
    const matches = (i: ProjectItem): boolean => {
      if (tokens.status.length) {
        const name = statusF?.options.find((o) => o.id === i.fieldValues[statusF.id])?.name.toLowerCase() ?? "";
        if (!tokens.status.some((s) => name.includes(s))) return false;
      }
      if (tokens.priority.length) {
        const name = prioF?.options.find((o) => o.id === i.fieldValues[prioF.id])?.name.toLowerCase() ?? "";
        if (!tokens.priority.some((p) => name.includes(p))) return false;
      }
      if (tokens.text) {
        const hay = `${i.draftTitle ?? ""} ${i.number ?? ""} ${i.repoLabel ?? ""}`.toLowerCase();
        if (!hay.includes(tokens.text.toLowerCase())) return false;
      }
      return true;
    };
    const sorted = [...items.value].filter(matches);
    if (sortBy.value === "priority" && prioF) {
      sorted.sort((a, b) => optionIndex(prioF, a) - optionIndex(prioF, b));
    } else if (sortBy.value === "added") {
      sorted.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    } else {
      sorted.sort((a, b) => Number(a.rank) - Number(b.rank));
    }
    return sorted;
  });

  function setFilterText(v: string) {
    filterText.value = v;
    localStorage.setItem(`${VIEW_KEY}.filter`, v);
  }

  const selected = computed(() => projects.value.find((p) => p.id === selectedId.value) ?? null);
  /** 列定义真源：builtin_status 字段的 options（数组序即列序）。 */
  const statusField = computed(() => fields.value.find((f) => f.kind === "builtin_status") ?? null);
  const priorityField = computed(() => fields.value.find((f) => f.name === "优先级") ?? null);

  async function loadProjects() {
    if (!isTauri()) return;
    try {
      projects.value = await api.projectList();
      if (!projects.value.some((p) => p.id === selectedId.value)) {
        selectedId.value = projects.value[0]?.id ?? null;
      }
      await loadSelected();
    } catch (e) {
      error.value = String(e);
    }
  }

  async function loadSelected() {
    if (!isTauri() || !selectedId.value) {
      fields.value = [];
      items.value = [];
      boundRepos.value = [];
      return;
    }
    try {
      [fields.value, items.value, boundRepos.value] = await Promise.all([
        api.projectFields(selectedId.value),
        api.projectItemList(selectedId.value),
        api.projectRepoList(selectedId.value),
      ]);
    } catch (e) {
      error.value = String(e);
    }
  }

  /** 工作区刷新入口（⌘R / 切到项目工作区）。 */
  async function loadAll() {
    loading.value = true;
    try {
      await loadProjects();
    } finally {
      loading.value = false;
    }
  }

  function select(id: string) {
    if (selectedId.value === id) return;
    selectedId.value = id;
    void loadSelected();
  }

  async function create(name: string, description?: string) {
    const p = await api.projectCreate(name, description);
    projects.value = [p, ...projects.value];
    selectedId.value = p.id;
    await loadSelected();
  }

  async function rename(id: string, name: string, description?: string) {
    const updated = await api.projectUpdate(id, name, description);
    projects.value = projects.value.map((p) => (p.id === id ? updated : p));
  }

  async function archive(id: string, archived: boolean) {
    await api.projectArchive(id, archived);
    await loadProjects();
  }

  async function remove(id: string) {
    await api.projectDelete(id);
    if (selectedId.value === id) selectedId.value = null;
    await loadProjects();
  }

  /** 添加条目并刷新当前板（后端已分配列与 rank）；返回新条目供列内快加
   * 追加指定列。 */
  async function addItem(args: Parameters<typeof api.projectItemAdd>[0]) {
    const item = await api.projectItemAdd(args);
    await loadSelected();
    return item;
  }

  /** 列改名：重写 builtin_status options（其余 option 原样保留）。 */
  async function renameStatusOption(optionId: string, name: string) {
    const field = statusField.value;
    if (!field) return;
    const options = field.options.map((o) => (o.id === optionId ? { ...o, name } : o));
    await api.projectFieldSetOptions(field.id, options);
    await loadSelected();
  }

  /** 拖拽/换列的统一落点：后端算 rank 中值。 */
  async function moveItem(itemId: string, statusOptionId?: string, prevId?: string, nextId?: string) {
    const moved = await api.projectItemMove(itemId, statusOptionId, prevId, nextId);
    items.value = items.value
      .map((i) => (i.id === moved.id ? moved : i))
      .sort((a, b) => Number(a.rank) - Number(b.rank));
  }

  async function removeItem(itemId: string) {
    await api.projectItemRemove(itemId);
    items.value = items.value.filter((i) => i.id !== itemId);
  }

  async function updateDraft(itemId: string, title: string, body?: string) {
    const updated = await api.projectItemUpdateDraft(itemId, title, body);
    items.value = items.value.map((i) => (i.id === updated.id ? updated : i));
  }

  async function setPriority(itemId: string, optionId?: string) {
    if (!priorityField.value) return;
    await api.projectFieldValueSet(itemId, priorityField.value.id, optionId);
    await loadSelected();
  }

  async function convertToIssue(itemId: string, repoPath: string) {
    const updated = await api.convertDraftToIssue(itemId, repoPath);
    items.value = items.value.map((i) => (i.id === updated.id ? updated : i));
  }

  async function bindRepo(repoId: string) {
    if (!selectedId.value) return;
    await api.projectRepoBind(selectedId.value, repoId);
    boundRepos.value = await api.projectRepoList(selectedId.value);
  }

  async function unbindRepo(repoId: string) {
    if (!selectedId.value) return;
    await api.projectRepoUnbind(selectedId.value, repoId);
    boundRepos.value = await api.projectRepoList(selectedId.value);
  }

  /** 状态列 options（含兜底，避免字段缺失时整板渲染失败）。 */
  function statusOptions(): FieldOption[] {
    return statusField.value?.options ?? [];
  }

  return {
    projects,
    selectedId,
    selected,
    fields,
    items,
    boundRepos,
    loading,
    error,
    navRequest,
    statusField,
    priorityField,
    filterText,
    sortBy,
    filteredItems,
    setFilterText,
    setSortBy,
    loadProjects,
    loadAll,
    select,
    create,
    rename,
    archive,
    remove,
    addItem,
    moveItem,
    removeItem,
    updateDraft,
    setPriority,
    convertToIssue,
    bindRepo,
    unbindRepo,
    renameStatusOption,
    statusOptions,
  };
});
