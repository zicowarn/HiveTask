/**
 * Projects board store — application-level (unlike issue/pull stores it
 * does NOT follow repo switches; the board is the cross-repo view).
 * The Rust side owns the truth (app.db); this store is a loadable cache.
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, type FieldOption, type Project, type ProjectField, type ProjectItem } from "../api";
import { isTauri } from "../api";

export const useProjectsStore = defineStore("projects", () => {
  const projects = ref<Project[]>([]);
  const selectedId = ref<string | null>(null);
  const fields = ref<ProjectField[]>([]);
  const items = ref<ProjectItem[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

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
      return;
    }
    try {
      [fields.value, items.value] = await Promise.all([
        api.projectFields(selectedId.value),
        api.projectItemList(selectedId.value),
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

  /** 添加条目并刷新当前板（后端已分配列与 rank）。 */
  async function addItem(args: Parameters<typeof api.projectItemAdd>[0]) {
    await api.projectItemAdd(args);
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
    loading,
    error,
    statusField,
    priorityField,
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
    statusOptions,
  };
});
