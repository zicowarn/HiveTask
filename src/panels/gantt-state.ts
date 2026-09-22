/**
 * 甘特共享状态（模块级单例，供各 Mode 与宿主面板共用）。
 *
 * 为什么要有这一层：甘特从「单面板」拆成「任务 / 资源 / 负载」三个 Mode 后，
 * 字段映射、关系缓存、任务树适配、依赖写路由都是**跨 Mode 的同一份状态**——
 * 放在某个 Mode 组件里，切 Mode 就会重置（用户立刻能察觉）。故按
 * `src/i18n` / `src/theme` 的既有单例风格抽出本模块。
 *
 * 领域数据仍在 projects store（deps/parents/itemResources/resourceCatalog）；
 * 这里只放**甘特特有**的派生状态与写路由。
 */
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { api, isTauri, type IssueRelations, type ProjectItem } from "../api";
import { useProjectsStore } from "../stores/projects";
import { translateError } from "../gh-errors";
import { pushToast } from "../toast";
import { useI18n } from "../i18n";
import { itemTitle } from "./item-fields";
import {
  buildGanttTree,
  defaultEndField,
  wouldCreateCycle,
  type GanttTask,
} from "./gantt-model";

// ---- 字段映射（工具条选择；跨 Mode 共用）----
export const startFieldId = ref("");
export const endFieldChoice = ref<string | null>(null); // null = 未手选（默认推断）
export const actualStartFieldId = ref("");
export const actualEndFieldId = ref("");
export const estHoursFieldId = ref("");
export const actHoursFieldId = ref("");
export const progressFieldId = ref("");

export function useGanttState() {
  const store = useProjectsStore();
  const { filteredItems, fields, selectedId, localDeps, localParents, resourceCatalog, itemResources } =
    storeToRefs(store);
  const { t } = useI18n();

  const dateFields = computed(() => fields.value.filter((f) => f.kind === "date"));
  const numberFields = computed(() => fields.value.filter((f) => f.kind === "number"));
  const startField = computed(
    () => dateFields.value.find((f) => f.id === startFieldId.value) ?? dateFields.value[0] ?? null,
  );
  const endField = computed(() => {
    if (endFieldChoice.value !== null) {
      return dateFields.value.find((f) => f.id === endFieldChoice.value) ?? null;
    }
    const id = defaultEndField(dateFields.value, startField.value?.id);
    return dateFields.value.find((f) => f.id === id) ?? null;
  });
  const actualStartField = computed(() => dateFields.value.find((f) => f.id === actualStartFieldId.value) ?? null);
  const actualEndField = computed(() => dateFields.value.find((f) => f.id === actualEndFieldId.value) ?? null);
  const estHoursField = computed(() => numberFields.value.find((f) => f.id === estHoursFieldId.value) ?? null);
  const actHoursField = computed(() => numberFields.value.find((f) => f.id === actHoursFieldId.value) ?? null);
  const progressField = computed(() => numberFields.value.find((f) => f.id === progressFieldId.value) ?? null);

  // ---- 仓库平台/路径缓存（形态判定与平台写用）----
  const repoPlatform = ref<Record<string, string>>({});
  const repoPaths = ref<Record<string, string>>({});
  async function loadRepos() {
    try {
      const repos = await api.repoList();
      const map: Record<string, string> = {};
      const paths: Record<string, string> = {};
      for (const r of repos) {
        if (!r.id) continue;
        map[r.id] = r.platform ?? "";
        const target = r.path || r.remoteUrl || "";
        if (target) paths[r.id] = target;
      }
      repoPlatform.value = map;
      repoPaths.value = paths;
    } catch {
      /* 平台未知 → 按平台形态处理（保守） */
    }
  }
  const repoPathOf = (repoId: string): string | null => repoPaths.value[repoId] ?? null;

  // ---- 关系数据（平台镜像：依赖/父子/进度）----
  const relationsByKey = ref<Record<string, IssueRelations>>({});
  const relationsLoading = ref(false);
  const relationsError = ref<string | null>(null);
  const relKey = (repoId: string | null, number: string | null) =>
    repoId && number ? `${repoId}::${number}` : "";

  async function loadRelations(force = false) {
    if (!isTauri() || !selectedId.value) return;
    const byRepo = new Map<string, string[]>();
    for (const it of filteredItems.value) {
      if (it.kind !== "issue" || !it.repoId || !it.number) continue;
      if (!force && relationsByKey.value[relKey(it.repoId, it.number)]) continue;
      const arr = byRepo.get(it.repoId) ?? [];
      arr.push(it.number);
      byRepo.set(it.repoId, arr);
    }
    if (!byRepo.size) return;
    relationsLoading.value = true;
    relationsError.value = null;
    try {
      const repos = await api.repoList();
      const targets = new Map<string, string>();
      for (const r of repos) {
        const target = r.path || r.remoteUrl || "";
        if (r.id && target) targets.set(r.id, target);
      }
      const merged = { ...relationsByKey.value };
      const mirror = new Map<string, { itemId: string; dependsOn: string }[]>();
      await Promise.all(
        [...byRepo.entries()].map(async ([repoId, numbers]) => {
          const target = targets.get(repoId);
          if (!target) return;
          const res = await api.issueRelationsBatch(target, numbers);
          for (const [number, relations] of Object.entries(res)) {
            merged[`${repoId}::${number}`] = relations;
          }
          const origin = repoPlatform.value[repoId] || "gh";
          const list = mirror.get(origin) ?? [];
          for (const [number, relations] of Object.entries(res)) {
            const item = filteredItems.value.find((i) => i.repoId === repoId && i.number === number);
            if (!item) continue;
            for (const ref of relations.blockedBy) {
              const blocker = filteredItems.value.find(
                (i) => i.repoId === repoId && i.number === ref.number,
              );
              if (blocker) list.push({ itemId: item.id, dependsOn: blocker.id });
            }
          }
          if (list.length) mirror.set(origin, list);
        }),
      );
      relationsByKey.value = merged;
      // 平台负责人 → 资源目录镜像（§5-bis R1）
      const logins = new Set<string>();
      for (const it of filteredItems.value) for (const a of it.entity?.assignees ?? []) logins.add(a);
      if (logins.size) {
        try {
          await store.syncResourceAssignees("gh", [...logins]);
        } catch {
          /* 镜像失败静默 */
        }
      }
      // 依赖镜像持久化（§4：离线可读）
      for (const [origin, edges] of mirror) {
        try {
          await store.syncPlatformDeps(origin, edges);
        } catch {
          /* 持久化失败静默：下次拉取再同步 */
        }
      }
    } catch (e) {
      relationsError.value = String(e);
    } finally {
      relationsLoading.value = false;
    }
  }

  // ---- 投影：条目 → 任务 → WBS 行 ----
  function numOf(item: ProjectItem, fieldId: string | null | undefined): number | null {
    if (!fieldId) return null;
    const raw = item.fieldValues[fieldId];
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  function dateOf(item: ProjectItem, fieldId: string | null | undefined): string | null {
    if (!fieldId) return null;
    const raw = item.fieldValues[fieldId];
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  const tasks = computed<GanttTask[]>(() =>
    filteredItems.value.map((it) => ({
      id: it.id,
      repoId: it.repoId,
      number: it.number,
      kind: it.kind,
      title: itemTitle(it),
      start: dateOf(it, startField.value?.id),
      end: dateOf(it, endField.value?.id),
      closed: (it.entity?.state ?? "").toUpperCase() === "CLOSED",
      progressOverride: numOf(it, progressField.value?.id),
      relations: relationsByKey.value[relKey(it.repoId, it.number)] ?? null,
      localDeps: localDeps.value[it.id],
      localParent: localParents.value[it.id] ?? null,
      assignees: it.entity?.assignees ?? [],
      actualStart: dateOf(it, actualStartField.value?.id),
      actualEnd: dateOf(it, actualEndField.value?.id),
      estimatedHours: numOf(it, estHoursField.value?.id),
      actualHours: numOf(it, actHoursField.value?.id),
    })),
  );
  const nodes = computed(() => buildGanttTree(tasks.value));
  const undatedCount = computed(() => nodes.value.filter((n) => !n.start).length);
  const idOf = computed(() => new Map(nodes.value.map((n, i) => [n.id, i + 1])));
  const nodeById = computed(() => new Map(nodes.value.map((n) => [n.id, n])));
  const nodeIdOf = computed(() => {
    const out = new Map<number, string>();
    for (const [nodeId, jid] of idOf.value) out.set(jid, nodeId);
    return out;
  });

  // ---- 写路由（容器/平台分流）----
  function isContainerForm(nodeId: string): boolean {
    const item = filteredItems.value.find((i) => i.id === nodeId);
    if (!item) return false;
    if (item.kind === "draft") return true;
    if (item.kind === "issue" && item.repoId) return repoPlatform.value[item.repoId] === "local";
    return false;
  }
  function platformWriteCtx(
    a: string,
    b: string,
  ): { repoPath: string; aNumber: string; bNumber: string } | null {
    const itemA = filteredItems.value.find((i) => i.id === a);
    const itemB = filteredItems.value.find((i) => i.id === b);
    if (!itemA?.repoId || !itemA.number || !itemB?.repoId || !itemB.number) return null;
    if (itemA.kind !== "issue" || itemB.kind !== "issue") return null;
    if (isContainerForm(a) || isContainerForm(b)) return null;
    const repoPath = repoPathOf(itemA.repoId);
    const repoPathB = repoPathOf(itemB.repoId);
    if (!repoPath || !repoPathB || repoPath !== repoPathB) return null;
    return { repoPath, aNumber: itemA.number, bNumber: itemB.number };
  }

  const handledEdgeRemovals = new Set<string>();
  async function addEdge(blockedId: string, blockerId: string) {
    const ctx = platformWriteCtx(blockedId, blockerId);
    if (ctx) {
      await api.issueDependencyAdd(ctx.repoPath, ctx.aNumber, ctx.repoPath, ctx.bNumber);
      return;
    }
    await store.addItemDep(blockedId, blockerId);
  }
  async function removeEdge(blockedId: string, blockerId: string) {
    const key = `${blockedId}->${blockerId}`;
    if (handledEdgeRemovals.has(key)) return;
    handledEdgeRemovals.add(key);
    setTimeout(() => handledEdgeRemovals.delete(key), 3000);
    const isLocal = (localDeps.value[blockedId] ?? []).includes(blockerId);
    if (isLocal) {
      await store.removeItemDep(blockedId, blockerId);
      return;
    }
    const ctx = platformWriteCtx(blockedId, blockerId);
    if (ctx) {
      await api.issueDependencyRemove(ctx.repoPath, ctx.aNumber, ctx.repoPath, ctx.bNumber);
      return;
    }
    throw new Error(t("gantt.depPlatformUnsupported"));
  }
  /** 前置任务数组 → 依赖边 diff。 */
  async function syncPredecessors(nodeId: string, nextIds: (number | string)[]) {
    const want = new Set(
      nextIds.map((jid) => nodeIdOf.value.get(Number(jid))).filter((id): id is string => !!id),
    );
    const have = new Set(nodeById.value.get(nodeId)?.dependsOn ?? []);
    for (const dep of want) if (!have.has(dep)) await addEdge(nodeId, dep);
    for (const dep of have) if (!want.has(dep)) await removeEdge(nodeId, dep);
  }

  /** 合并图（平台镜像 ∪ 容器真源）：环检测在合并图上做（跨形态环才拦得住）。 */
  const graphDeps = computed<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    for (const n of nodes.value) out[n.id] = [...n.dependsOn];
    return out;
  });

  return {
    // 领域
    filteredItems,
    selectedId,
    localDeps,
    localParents,
    resourceCatalog,
    itemResources,
    // 字段映射（ref/计算属性原样暴露：面板工具条可直接改）
    startFieldId,
    endFieldChoice,
    actualStartFieldId,
    actualEndFieldId,
    estHoursFieldId,
    actHoursFieldId,
    progressFieldId,
    dateFields,
    numberFields,
    startField,
    endField,
    actualStartField,
    actualEndField,
    estHoursField,
    actHoursField,
    progressField,
    // 仓库
    repoPlatform,
    repoPaths,
    loadRepos,
    repoPathOf,
    // 关系
    relationsByKey,
    relationsLoading,
    relationsError,
    relKey,
    loadRelations,
    // 投影
    tasks,
    nodes,
    undatedCount,
    idOf,
    nodeById,
    nodeIdOf,
    numOf,
    dateOf,
    // 写路由
    setFieldValue: (itemId: string, fieldId: string, value?: string) =>
      store.setFieldValue(itemId, fieldId, value),
    isContainerForm,
    platformWriteCtx,
    addEdge,
    removeEdge,
    syncPredecessors,
    graphDeps,
    reportError: (e: unknown) => pushToast({ kind: "error", message: translateError(String(e)) }),
    wouldCreateCycle,
  };
}
