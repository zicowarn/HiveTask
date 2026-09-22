/**
 * Projects board store — application-level (unlike issue/pull stores it
 * does NOT follow repo switches; the board is the cross-repo view).
 * The Rust side owns the truth (app.db); this store is a loadable cache.
 */
import { defineStore } from "pinia";
import { translateError } from "../gh-errors";
import { computed, ref, watch } from "vue";
import {
  api,
  type BoundRepo,
  type FieldOption,
  type Resource,
  type MilestoneInfo,
  type Project,
  type ProjectField,
  type ProjectItem,
} from "../api";
import { isTauri } from "../api";
import { pushToast } from "../toast";
import { useI18n } from "../i18n";
import type { ProjectLayout, ProjectViewConfig, ProjectViewEntry } from "../panels/project-views";
import {
  defaultViewConfig,
  defaultViewEntries,
  entityFieldIds,
  fieldLabelKeys,
  projectFieldIds,
  TABLE_DEFAULT_FIELDS,
  VIEW_CONFIG_VERSION,
  viewFieldIds,
} from "../panels/project-views";
import { entityFieldText, kindLabel, shortDate, itemTitle, sourceLabel } from "../panels/item-fields";
import { t } from "../i18n";

export const useProjectsStore = defineStore("projects", () => {
  const projects = ref<Project[]>([]);
  const selectedId = ref<string | null>(null);
  const fields = ref<ProjectField[]>([]);
  const items = ref<ProjectItem[]>([]);
  const boundRepos = ref<BoundRepo[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** 列发布（本地 → 线上）的最近一次错误；成功即清空。 */
  const publishError = ref<string | null>(null);
  /** 跨工作区导航请求（看板卡片 → Issues；状态栏 → 项目工作区）。
   * repoId = 登记表 id，App.vue 消费时解析成 path/URL target。 */
  const navRequest = ref<{ workspace: string; repoId?: string; number?: string; panel?: string } | null>(null);
  /** item 详情抽屉（Board / Table 共用；平台的面板挂在视图层而非某个布局）。 */
  const panelItemId = ref<string | null>(null);

  // ---- 视图配置（筛选 / 排序 / 方向 / 分列字段 / 显示字段）----
  // 收成一个对象、按项目分键存 JSON：预设套用与落盘都是原子的，将来加维度
  // （分组、泳道）不必再动存储格式。
  const view = ref<ProjectViewConfig>(defaultViewConfig());
  function viewKey(): string {
    return `hivetask.project-view.${selectedId.value ?? "_"}`;
  }
  /** 切项目即换一整套配置（旧实现是全局键，两个项目共用一份筛选/排序）。 */
  function loadViewConfig(): void {
    loadViews(localStorage.getItem(viewsKey()));
    const raw = localStorage.getItem(viewKey());
    if (!raw) {
      view.value = defaultViewConfig();
      return;
    }
    try {
      const saved = JSON.parse(raw) as Partial<ProjectViewConfig>;
      const merged = { ...defaultViewConfig(), ...saved };
      // 目录扩容（version 落后）：把用户没关过、只是当时还不存在的固定字段补回来
      if ((saved.version ?? 1) < VIEW_CONFIG_VERSION) {
        const extra = viewFieldIds.filter((id) => !(saved.fields ?? []).includes(id));
        merged.fields = [...extra, ...(saved.fields ?? [])] as ProjectViewConfig["fields"];
      }
      // Table 布局列集迁移（活动视图的遗留副本）：未定制过 = 旧全集 → 平台默认列集
      if (activeView.value.layout === "table" && isUntouchedLegacyFields(merged.fields)) {
        merged.fields = [...TABLE_DEFAULT_FIELDS] as ProjectViewConfig["fields"];
      }
      view.value = merged;
    } catch {
      view.value = defaultViewConfig();
    }
  }
  /** 视图播种（对**每个视图**各播一次，不只是当前那个）：
   * ① 新字段（线上同步补出来的 Size / Estimate）默认入显示字段——否则它们只在 ⚙ 目录里，
   *    看板卡片、表格列都不显示；
   * ② 数字字段求和默认打开——平台视图实测 `Field sum: Count, Estimate`。
   * 两项都以「播种过」标志 + knownFieldIds 记已见：用户之后手动关掉的不会被放回来。 */
  function seedConfig(cfg: ProjectViewConfig): ProjectViewConfig {
    let next = cfg;
    const known = new Set(cfg.knownFieldIds ?? []);
    const fresh = fields.value
      .map((f) => ({ key: viewKeyOfField(f), fieldId: f.id }))
      .filter((e) => !known.has(e.fieldId));
    if (fresh.length > 0) {
      for (const e of fresh) known.add(e.fieldId);
      const shown = new Set(next.fields as string[]);
      next = {
        ...next,
        knownFieldIds: [...known],
        fields: [...next.fields, ...fresh.map((e) => e.key).filter((k) => !shown.has(k))] as ProjectViewConfig["fields"],
      };
    }
    if (!next.sumsSeeded) {
      const keys = numberFields.value.map((f) => viewKeyOfField(f)).filter((k) => !next.sumFieldIds.includes(k));
      next = { ...next, sumFieldIds: [...next.sumFieldIds, ...keys], sumsSeeded: true };
    }
    return next;
  }

  /** 把所有视图的配置过一遍播种（活动视图的副本同步后由 watch 写回条目）。 */
  function expandCatalogue(): void {
    views.value = views.value.map((v) => ({ ...v, config: seedConfig(v.config) }));
    view.value = seedConfig(view.value);
    localStorage.setItem(viewsKey(), JSON.stringify({ views: views.value, activeId: activeViewId.value }));
  }
  // sync：回填必须与切换同拍，否则晚一拍会把同一 tick 内刚写下的配置清回旧值
  watch(view, (v) => localStorage.setItem(viewKey(), JSON.stringify(v)), {
    deep: true,
    flush: "sync",
  });
  watch(selectedId, loadViewConfig, { flush: "sync" });
  function setSortBy(v: ProjectViewConfig["sortBy"]) {
    view.value.sortBy = v;
  }
  function setSortDesc(v: boolean) {
    view.value.sortDesc = v;
  }
  /** 逐字段排序（平台列选项：Sort ascending / descending）。 */
  function setFieldSort(fieldId: string | null, desc = false) {
    view.value.fieldSort = fieldId ? { fieldId, desc } : null;
  }
  /** 按字段值筛选（平台：Filter by values…）：写入 `字段名:值` token。 */
  function addFieldFilter(field: ProjectField, optionName: string) {
    const token = `${field.name}:${optionName}`;
    const current = view.value.filter.trim();
    view.value.filter = current ? `${current} ${token}` : token;
  }
  function setDateEndFieldId(id: string | null) {
    view.value.dateEndFieldId = id;
  }
  /** Roadmap 标记开关（平台 Markers 菜单：里程碑 / 开始日期 / 结束日期）。 */
  function setMarkersMilestones(on: boolean) {
    view.value.markersMilestones = on;
  }
  function setMarkersStartDate(on: boolean) {
    view.value.markersStartDate = on;
  }
  function setMarkersDueDate(on: boolean) {
    view.value.markersDueDate = on;
  }

  // ---- Roadmap 里程碑标记线元数据：条目引用的里程碑 → due_on ----
  /** 反应式快照（repoId → 该仓库里程碑列表 + 显示名）；供标记线投影。 */
  const roadmapMilestoneMeta = ref<Record<string, { label: string; list: MilestoneInfo[] }>>({});
  /** 会话级缓存：同一仓库只拉一次（对齐 issues store 里程碑元数据的
   *  「首访拉取、缓存到会话结束」语义；失败仓库静默跳过——标记线是投影，
   *  不是数据义务）。 */
  const milestoneMetaCache = new Map<string, { label: string; list: MilestoneInfo[] }>();
  async function loadRoadmapMilestones() {
    if (!isTauri()) return;
    // repoId → target 从**登记表**解析，不依赖项目绑定（project_repos）：
    // 线上导入的项目条目自带 repo_id，但从未手动绑定仓库 → boundRepos 为空，
    // 曾因此静默不拉取（无 toast、无线）。条目引用的仓库必然在 repos 表。
    const targets = new Map<string, string>(); // repoId → target（path / remote_url）
    const labels = new Map<string, string>();
    const wanted = new Set<string>();
    for (const it of items.value) {
      if (it.repoId && it.entity?.milestone) wanted.add(it.repoId);
    }
    if (!wanted.size) return;
    const pending = [...wanted].filter((id) => !milestoneMetaCache.has(id));
    if (!pending.length) return;
    const { t } = useI18n();
    try {
      for (const row of await api.repoList()) {
        const target = row.path || row.remoteUrl || "";
        if (row.id && target && pending.includes(row.id)) {
          targets.set(row.id, target);
          labels.set(row.id, row.displayName || target.split("/").filter(Boolean).pop() || target);
        }
      }
    } catch (e) {
      console.warn("loadRoadmapMilestones: repoList failed", e);
      return;
    }
    await Promise.all(
      [...targets.entries()].map(async ([repoId, target]) => {
        const label = labels.get(repoId) ?? target;
        try {
          milestoneMetaCache.set(repoId, { label, list: await api.milestoneList(target) });
        } catch (e) {
          // 失败不进缓存（下次触发会重试），但必须可见——静默吞掉曾导致
          // 「勾了里程碑却无线」且无从排查（应用内 gh 间歇 EOF，命令行正常）。
          console.warn("loadRoadmapMilestones failed:", target, e);
          pushToast({ kind: "info", message: t("project.milestoneFetchFail", { repo: label }) });
        }
      }),
    );
    roadmapMilestoneMeta.value = Object.fromEntries(milestoneMetaCache);
  }
  function setColumnFieldId(id: string | null) {
    view.value.columnFieldId = id;
  }
  function setSwimlaneFieldId(id: string | null) {
    view.value.swimlaneFieldId = id;
  }
  /** 合计项开关：计数（"count"）与数字字段 id。 */
  function toggleSum(id: string) {
    const has = view.value.sumFieldIds.includes(id);
    view.value.sumFieldIds = has
      ? view.value.sumFieldIds.filter((s) => s !== id)
      : [...view.value.sumFieldIds, id];
  }
  /** 显示字段开关（保持目录顺序，配置比较才稳定）。 */
  function toggleField(id: ProjectViewConfig["fields"][number]) {
    const has = view.value.fields.includes(id);
    view.value.fields = viewFieldIds.filter((f) => (f === id ? !has : view.value.fields.includes(f)));
  }

  interface FilterTokens {
    text: string;
    /** 字段 id → 需要匹配的取值片段（含 status / priority 两个别名）。 */
    byField: Map<string, string[]>;
  }
  /** 解析 `字段名:值 自由文本`：别名 status/priority + 任意字段名皆可，
   * 未识别的 aaa:bbb 按自由文本处理。 */
  function parseFilter(raw: string, aliasToField: Map<string, string>): FilterTokens {
    const tokens: FilterTokens = { text: "", byField: new Map() };
    for (const part of raw.split(/\s+/).filter(Boolean)) {
      const m = part.match(/^([^:]+):(.+)$/);
      if (!m) {
        tokens.text += (tokens.text ? " " : "") + part;
        continue;
      }
      const key = m[1]!.toLowerCase();
      const fieldId = aliasToField.get(key);
      if (!fieldId) {
        tokens.text += (tokens.text ? " " : "") + part;
        continue;
      }
      const needle = m[2]!.replace(/^"|"$/g, "").toLowerCase();
      const list = tokens.byField.get(fieldId) ?? [];
      list.push(needle);
      tokens.byField.set(fieldId, list);
    }
    return tokens;
  }

  /** 过滤 + 排序后的条目（切片过滤之前；左导航的计数与 Team items 值列表用它）。 */
  const preSliceItems = computed(() => {
    const statusF = fields.value.find((f) => f.kind === "builtin_status") ?? null;
    const prioF = fields.value.find((f) => f.name === "优先级") ?? null;
    const optionIndex = (field: ProjectField | null, item: ProjectItem): number => {
      if (!field) return -1;
      const v = item.fieldValues[field.id];
      const idx = field.options.findIndex((o) => o.id === v);
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
    };
    // 别名：status → 内置状态字段；priority → 优先级字段；其余按字段名原样匹配
    const aliasToField = new Map<string, string>();
    for (const f of fields.value) {
      if (f.id) aliasToField.set(f.name.toLowerCase(), f.id);
    }
    if (statusF) aliasToField.set("status", statusF.id);
    if (prioF) aliasToField.set("priority", prioF.id);
    // 固定字段别名（i18n 列名 → 固定键）：平台任意列都能按值筛选
    for (const id of viewFieldIds) {
      aliasToField.set(t(fieldLabelKeys[id]).toLowerCase(), id);
    }
    const tokens = parseFilter(view.value.filter, aliasToField);
    const matches = (i: ProjectItem): boolean => {
      for (const [fieldId, needles] of tokens.byField) {
        const field = fields.value.find((f) => f.id === fieldId);
        // 项目字段匹配选项名；固定字段匹配单元格显示文本
        const name = field
          ? (field.options.find((o) => o.id === i.fieldValues[fieldId])?.name.toLowerCase() ?? "")
          : (cellOf(fieldId, i)?.text.toLowerCase() ?? "");
        if (!needles.some((n) => name.includes(n))) return false;
      }
      if (tokens.text) {
        const hay = `${i.draftTitle ?? ""} ${i.number ?? ""} ${i.repoLabel ?? ""}`.toLowerCase();
        if (!hay.includes(tokens.text.toLowerCase())) return false;
      }
      return true;
    };
    const sorted = [...items.value].filter(matches);
    const fs = view.value.fieldSort;
    if (fs) {
      const field = fields.value.find((f) => f.id === fs.fieldId) ?? null;
      if (field) {
        const idx = (i: ProjectItem) => {
          const optId = i.fieldValues[field.id];
          const at = field.options.findIndex((o) => o.id === optId);
          return at === -1 ? Number.MAX_SAFE_INTEGER : at;
        };
        sorted.sort((a, b) => (fs.desc ? -1 : 1) * (idx(a) - idx(b)));
        return sorted;
      }
      // 固定字段：按单元格显示文本排序（平台任意列可排序），空值恒排末尾
      const txt = (i: ProjectItem) => cellOf(fs.fieldId, i)?.text ?? "";
      sorted.sort((a, b) => {
        const ta = txt(a);
        const tb = txt(b);
        if (!ta && !tb) return 0;
        if (!ta) return 1;
        if (!tb) return -1;
        return (fs.desc ? -1 : 1) * ta.localeCompare(tb, "zh-Hans-CN");
      });
      return sorted;
    }
    const dir = view.value.sortDesc ? -1 : 1;
    if (view.value.sortBy === "priority" && prioF) {
      // 无值的条目恒排末尾（不随方向翻转）
      sorted.sort((a, b) => {
        const ia = optionIndex(prioF, a);
        const ib = optionIndex(prioF, b);
        if (ia === ib) return 0;
        if (ia === Number.MAX_SAFE_INTEGER) return 1;
        if (ib === Number.MAX_SAFE_INTEGER) return -1;
        return dir * (ia - ib);
      });
    } else if (view.value.sortBy === "added") {
      sorted.sort((a, b) => dir * a.addedAt.localeCompare(b.addedAt));
    } else {
      sorted.sort((a, b) => Number(a.rank) - Number(b.rank));
    }
    return sorted;
  });

  /** 切片过滤后的条目（Board/Table/Roadmap 三种投影共用；平台 Team items：
   *  左导航选中某值 → 主区只显示该值的条目）。选中 "" = 无值切片（No Assignees
   *  这类聚合行），仍要过滤——只有字段为 null（不切片）才放行全量。 */
  const filteredItems = computed(() => {
    const key = view.value.sliceFieldId;
    const val = view.value.sliceValue;
    if (!key || val === null) return preSliceItems.value;
    return preSliceItems.value.filter((i) => sliceValuesOf(i, key).includes(val));
  });

  const selected = computed(() => projects.value.find((p) => p.id === selectedId.value) ?? null);
  /** 抽屉当前条目（按 id 取，字段写入重载后自动更新）。 */
  const panelItem = computed(() => items.value.find((i) => i.id === panelItemId.value) ?? null);
  function openPanelItem(id: string) {
    panelItemId.value = id;
  }
  function closePanelItem() {
    panelItemId.value = null;
  }
  watch(selectedId, () => {
    panelItemId.value = null;
  });
  /** 列定义真源：builtin_status 字段的 options（数组序即列序）。 */
  const statusField = computed(() => fields.value.find((f) => f.kind === "builtin_status") ?? null);
  const priorityField = computed(() => fields.value.find((f) => f.name === "优先级") ?? null);
  /** 当前分列字段：视图配置指定，缺省回落状态字段。 */
  const columnField = computed(
    () => fields.value.find((f) => f.id === view.value.columnFieldId) ?? statusField.value,
  );
  /** 可作分列的字段（单选类），供「分列方式」子面板选择。 */
  const columnFieldChoices = computed(() =>
    fields.value.filter((f) => f.kind === "builtin_status" || f.kind === "single_select"),
  );
  /** 项目字段在视图配置里的键：内置状态/优先级用固定语义键，自建字段用其 id
   * （视图配置按项目持久化，id 在项目内稳定）。 */
  function viewKeyOfField(field: ProjectField): string {
    if (field.kind === "builtin_status") return "status";
    if (field === priorityField.value) return "priority";
    return field.id;
  }
  /** 字段面板目录：条目自身 + 引用实体镜像（固定）+ 项目字段（含自建，按 position）。 */
  const fieldCatalogue = computed(() => {
    const fixed = viewFieldIds
      .filter((id) => !projectFieldIds.includes(id))
      .map((id) => ({ id: id as string, name: t(fieldLabelKeys[id]), section: entityFieldIds.includes(id) ? "entity" : "" }));
    const project = fields.value.map((f) => ({
      id: viewKeyOfField(f),
      name: projectFieldIds.includes(viewKeyOfField(f) as (typeof projectFieldIds)[number])
        ? t(fieldLabelKeys[viewKeyOfField(f) as keyof typeof fieldLabelKeys])
        : f.name,
      section: "project",
    }));
    return [...fixed, ...project];
  });
  /** 字段显示名（固定字段走 i18n，自建字段用字段名）。 */
  function fieldName(id: string): string {
    const fixed = fieldLabelKeys[id as keyof typeof fieldLabelKeys];
    if (fixed) return t(fixed);
    return fields.value.find((f) => f.id === id)?.name ?? id;
  }
  /** 字段在卡片/表格里的一格：固定字段走本地/i18n，项目字段走字段值。 */
  function cellOf(id: string, item: ProjectItem): { text: string; color: string | null } | null {
    switch (id) {
      case "title":
        return { text: itemTitle(item), color: null };
      case "kind":
        return { text: kindLabel(item), color: null };
      case "source":
        return { text: sourceLabel(item), color: null };
      case "added":
        return { text: shortDate(item.addedAt), color: null };
      default:
        break;
    }
    if (entityFieldIds.includes(id as never)) {
      const text = entityFieldText(id as never, item);
      return text ? { text, color: null } : null;
    }
    const field = fields.value.find((f) => viewKeyOfField(f) === id);
    if (!field) return null;
    const raw = item.fieldValues[field.id] ?? "";
    if (!raw) return null;
    if (field.kind === "single_select" || field.kind === "builtin_status") {
      const option = field.options.find((o) => o.id === raw);
      return option ? { text: option.name, color: option.color } : null;
    }
    return { text: raw, color: null };
  }

  /** 新建项目字段（落 app.db；成功后立即纳入当前视图的显示字段）。 */
  async function createField(name: string, kind: string, optionNames: string[]) {
    if (!selectedId.value) return null;
    const field = await api.projectFieldCreate(selectedId.value, name, kind, optionNames);
    await loadSelected();
    const key = viewKeyOfField(field);
    if (!view.value.fields.includes(key as never)) {
      view.value.fields = [...view.value.fields, key as never];
    }
    return field;
  }

  /** 写字段值（单选 / 文本 / 数字 / 日期统一入口）。 */
  async function setFieldValue(itemId: string, fieldId: string, value?: string) {
    await api.projectFieldValueSet(itemId, fieldId, value);
    await loadSelected();
  }

  // ---- 列 / 泳道组的 ⋯ 动作（对齐 GitHub 的 Actions 菜单）----

  // ---- 视图列表（GitHub 的 views）：每视图 = 名字 + 布局 + 一套配置 ----
  const views = ref<ProjectViewEntry[]>(defaultViewEntries());
  const activeViewId = ref<string>(views.value[0]!.id);
  const activeView = computed(
    () => views.value.find((v) => v.id === activeViewId.value) ?? views.value[0]!,
  );
  const layout = computed<ProjectLayout>(() => activeView.value.layout);
  /** 视图配置写回活动视图（单一事实源 = 活动视图的 config）。 */
  watch(
    view,
    (v) => {
      const entry = views.value.find((e) => e.id === activeViewId.value);
      if (entry) entry.config = { ...v, fields: [...v.fields] };
      localStorage.setItem(viewsKey(), JSON.stringify({ views: views.value, activeId: activeViewId.value }));
    },
    { deep: true, flush: "sync" },
  );
  function viewsKey(): string {
    return `hivetask.project-views.${selectedId.value ?? "_"}`;
  }
  /** 切视图：套用该视图的配置（布局随之切换）。 */
  function setActiveView(id: string) {
    const entry = views.value.find((v) => v.id === id);
    if (!entry) return;
    activeViewId.value = id;
    view.value = { ...entry.config, fields: [...entry.config.fields] };
    localStorage.setItem(viewsKey(), JSON.stringify({ views: views.value, activeId: id }));
  }
  /** 切当前视图的布局（View 弹层的 Layout 分段）。 */
  function setLayout(next: ProjectLayout) {
    const entry = views.value.find((e) => e.id === activeViewId.value);
    if (entry) entry.layout = next;
    localStorage.setItem(viewsKey(), JSON.stringify({ views: views.value, activeId: activeViewId.value }));
  }
  /** 新建视图（平台的 New view）：按选定布局建，默认板面配置，名字「View N」。 */
  function addView(layout?: ProjectLayout) {
    const n = views.value.length + 1;
    const entry: ProjectViewEntry = {
      id: `view-${Date.now()}`,
      name: `View ${n}`,
      layout: layout ?? activeView.value.layout,
      config: defaultViewConfig(),
    };
    views.value = [...views.value, entry];
    setActiveView(entry.id);
    return entry;
  }
  /** 选中视图的选项菜单（平台 View options）：重命名 / 移动 / 复制 / 删除。 */
  function renameView(id: string, name: string) {
    const entry = views.value.find((v) => v.id === id);
    if (!entry || !name.trim()) return;
    entry.name = name.trim();
    persistViews();
  }
  function moveView(id: string, dir: -1 | 1) {
    const idx = views.value.findIndex((v) => v.id === id);
    const next = idx + dir;
    if (idx < 0 || next < 0 || next >= views.value.length) return;
    const list = [...views.value];
    const [moved] = list.splice(idx, 1);
    if (moved) list.splice(next, 0, moved);
    views.value = list;
    persistViews();
  }
  function duplicateView(id: string) {
    const entry = views.value.find((v) => v.id === id);
    if (!entry) return;
    const copy: ProjectViewEntry = {
      id: `view-${Date.now()}`,
      name: `${entry.name} copy`,
      layout: entry.layout,
      config: { ...entry.config, fields: [...entry.config.fields] },
    };
    const idx = views.value.findIndex((v) => v.id === id);
    views.value = [...views.value.slice(0, idx + 1), copy, ...views.value.slice(idx + 1)];
    persistViews();
  }
  function deleteView(id: string) {
    if (views.value.length <= 1) return; // 至少保留一个视图
    const idx = views.value.findIndex((v) => v.id === id);
    if (idx < 0) return;
    views.value = views.value.filter((v) => v.id !== id);
    if (activeViewId.value === id) {
      const next = views.value[Math.max(0, idx - 1)] ?? views.value[0]!;
      setActiveView(next.id);
    } else {
      persistViews();
    }
  }
  function persistViews() {
    localStorage.setItem(viewsKey(), JSON.stringify({ views: views.value, activeId: activeViewId.value }));
  }
  /** Table 布局列集迁移的「未定制」判定：fields 覆盖全部固定字段
   * （旧种子发的就是全集；用户加删过列则不再满足）。幂等，随加载常驻。 */
  function isUntouchedLegacyFields(fields: ProjectViewConfig["fields"]): boolean {
    const set = new Set<string>(fields as string[]);
    return viewFieldIds.every((id) => set.has(id));
  }
  function loadViews(raw: string | null) {
    if (!raw) {
      views.value = defaultViewEntries();
      activeViewId.value = views.value[0]!.id;
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { views?: ProjectViewEntry[]; activeId?: string };
      const list = parsed.views?.length ? parsed.views : defaultViewEntries();
      const restored = list.map((v) => ({ ...v, config: { ...defaultViewConfig(), ...v.config } }));
      // 新增的内置视图（如 Roadmap）补进旧列表——用户没删过它，只是当时还不存在
      for (const seed of defaultViewEntries()) {
        if (!restored.some((v) => v.id === seed.id)) restored.push(seed);
      }
      // Table 布局列集迁移（2026-09 对齐平台）：旧种子发的是全字段，凡未定制过
      // 的 Table 视图收敛为平台默认列集；定制过的（增删过列）保持不动
      for (const v of restored) {
        if (v.layout === "table" && isUntouchedLegacyFields(v.config.fields)) {
          v.config = { ...v.config, fields: [...TABLE_DEFAULT_FIELDS] as ProjectViewConfig["fields"] };
        }
      }
      views.value = restored;
      activeViewId.value = list.some((v) => v.id === parsed.activeId)
        ? (parsed.activeId as string)
        : list[0]!.id;
    } catch {
      views.value = defaultViewEntries();
      activeViewId.value = views.value[0]!.id;
    }
  }

  /** 本地列 → 线上：把本地单选字段的选项表（名称/顺序/颜色/说明）整体推到线上项目。
   * 列设置按用户要求是双向的——本地改完即发布，平台刷新时再覆盖回本地；
   * 未绑定线上项目的本地项目无此步骤。失败不阻塞本地改动，只把原因写进 publishError。 */
  async function publishColumns() {
    const project = selected.value;
    if (!project?.platformRef || !isTauri()) return;
    try {
      await api.projectPublishColumns(project.id);
      publishError.value = null;
    } catch (e) {
      publishError.value = translateError(String(e));
    }
  }

  /** 新建选项（看板最右「新建列」/ 泳道面板「新建泳道」）：返回新选项。 */
  async function addOption(fieldId: string, name: string, color?: string) {
    const field = await api.projectFieldOptionAdd(fieldId, name, color);
    await loadSelected();
    await publishColumns();
    const added = field.options[field.options.length - 1] ?? null;
    return added;
  }

  /** 编辑详情（GitHub 的 Edit option）：名称 / 颜色 / 说明一次写入。 */
  async function updateOption(
    fieldId: string,
    optionId: string,
    patch: { name: string; color: string; description: string },
  ) {
    const field = fields.value.find((f) => f.id === fieldId);
    if (!field) return;
    const options = field.options.map((o) =>
      o.id === optionId
        ? { ...o, name: patch.name, color: patch.color, description: patch.description || null }
        : o,
    );
    await api.projectFieldSetOptions(field.id, options);
    await loadSelected();
    await publishColumns();
  }
  /** 删除列/段：先清掉落在该选项上的条目值（它们回到「无 <字段>」列），再删选项。 */
  async function deleteOption(fieldId: string, optionId: string) {
    const field = fields.value.find((f) => f.id === fieldId);
    if (!field) return;
    for (const item of items.value.filter((i) => i.fieldValues[field.id] === optionId)) {
      await api.projectFieldValueSet(item.id, field.id);
    }
    await api.projectFieldSetOptions(field.id, field.options.filter((o) => o.id !== optionId));
    await loadSelected();
    await publishColumns();
  }
  /** 位置：选项左移 / 右移（重写 options 顺序）。 */
  async function moveOption(fieldId: string, optionId: string, dir: -1 | 1) {
    const field = fields.value.find((f) => f.id === fieldId);
    if (!field) return;
    const idx = field.options.findIndex((o) => o.id === optionId);
    const next = idx + dir;
    if (idx < 0 || next < 0 || next >= field.options.length) return;
    const options = [...field.options];
    const [moved] = options.splice(idx, 1);
    if (moved) options.splice(next, 0, moved);
    await api.projectFieldSetOptions(field.id, options);
    await loadSelected();
    await publishColumns();
  }
  /** 条目：全部移除该列（或该段内）的条目。 */
  async function removeItemsIn(fieldId: string, optionId: string) {
    const field = fields.value.find((f) => f.id === fieldId);
    if (!field) return;
    for (const item of items.value.filter((i) => (i.fieldValues[field.id] ?? "") === optionId)) {
      await api.projectItemRemove(item.id);
    }
    await loadSelected();
  }
  /** 从视图中隐藏 / 显示某列或某泳道段（视图配置，不动物据）。 */
  function toggleHidden(kind: "column" | "lane", optionId: string) {
    const key = kind === "column" ? "hiddenColumns" : "hiddenLanes";
    const list = view.value[key];
    view.value[key] = list.includes(optionId) ? list.filter((v) => v !== optionId) : [...list, optionId];
  }
  function isHidden(kind: "column" | "lane", optionId: string): boolean {
    return view.value[kind === "column" ? "hiddenColumns" : "hiddenLanes"].includes(optionId);
  }
  /** 设置上限（0 = 无上限）。 */
  function setColumnLimit(optionId: string, limit: number) {
    const next = { ...view.value.columnLimits };
    if (limit > 0) next[optionId] = limit;
    else delete next[optionId];
    view.value.columnLimits = next;
  }
  /** 泳道字段：视图配置指定（Board 的第二分组维度）。 */
  const swimlaneField = computed(
    () => fields.value.find((f) => viewKeyOfField(f) === view.value.swimlaneFieldId) ?? null,
  );
  /** 泳道段：泳道字段的 options；有条目缺该字段值时追加「无」段（id = ""）。 */
  function swimlaneOptions(): FieldOption[] {
    const field = swimlaneField.value;
    if (!field) return [];
    const hasEmpty = items.value.some((i) => !i.fieldValues[field.id]);
    return hasEmpty ? [...field.options, { id: "", name: "", color: "" }] : field.options;
  }
  /** 数字字段（可做列头合计的候选）。 */
  const numberFields = computed(() => fields.value.filter((f) => f.kind === "number"));
  /** 某列（某泳道段内）的合计：计数 + 数字字段求和。 */
  function columnSums(optionId: string, laneId: string | null): { label: string; value: number }[] {
    const column = columnField.value;
    if (!column) return [];
    const lane = swimlaneField.value;
    const inCell = items.value.filter((i) => {
      const colHit = (i.fieldValues[column.id] ?? "") === optionId;
      const laneHit = !lane || laneId === null ? true : (i.fieldValues[lane.id] ?? "") === laneId;
      return colHit && laneHit;
    });
    const out: { label: string; value: number }[] = [];
    // 计数由列头的 CounterLabel 单独渲染（平台形态），这里只出数字字段求和
    for (const f of numberFields.value) {
      if (!view.value.sumFieldIds.includes(viewKeyOfField(f))) continue;
      const sum = inCell.reduce((acc, i) => acc + (Number(i.fieldValues[f.id]) || 0), 0);
      out.push({ label: f.name, value: sum });
    }
    return out;
  }
  /** 泳道段合计（该段全部条目；与列合计同口径）。 */
  function laneSums(laneId: string): { label: string; value: number }[] {
    const lane = swimlaneField.value;
    if (!lane) return [];
    const inLane = items.value.filter((i) => (i.fieldValues[lane.id] ?? "") === laneId);
    const out: { label: string; value: number }[] = [];
    for (const f of numberFields.value) {
      if (!view.value.sumFieldIds.includes(viewKeyOfField(f))) continue;
      out.push({
        label: f.name,
        value: inLane.reduce((acc, i) => acc + (Number(i.fieldValues[f.id]) || 0), 0),
      });
    }
    return out;
  }
  /** 折叠 / 展开泳道段（平台的 Collapse group）。 */
  function toggleLaneCollapsed(optionId: string) {
    const list = view.value.collapsedLanes;
    view.value.collapsedLanes = list.includes(optionId)
      ? list.filter((v) => v !== optionId)
      : [...list, optionId];
  }
  function isLaneCollapsed(optionId: string): boolean {
    return view.value.collapsedLanes.includes(optionId);
  }

  /** 视图配置键 → 字段本体（自建字段按 id 查；状态/优先级按键名查）。 */
  function fieldByViewKey(id: string): ProjectField | null {
    return fields.value.find((f) => viewKeyOfField(f) === id) ?? null;
  }

  // ---- Team items 切片（平台 Slicer，2026-09 取证 views/3）----
  // 切片字段键：assignees/repository 为固定语义键，其余 = 项目字段的 viewKey
  // （status/priority 固定、自建字段按 id）。null 字段 = 不切片（左导航收起）。

  /** 条目在某切片字段上的取值集合（assignees 可多值——条目计入每个负责人行；
   *  其余单值；空 = ""，对应导航的「无 X」行）。 */
  function sliceValuesOf(item: ProjectItem, key: string): string[] {
    if (key === "assignees") {
      const list = item.entity?.assignees ?? [];
      return list.length ? list : [""];
    }
    if (key === "repository") return [item.repoId ?? ""];
    const field = fieldByViewKey(key);
    if (!field) return [];
    return [item.fieldValues[field.id] ?? ""];
  }

  interface SliceRow {
    value: string;
    label: string;
    description: string | null;
    count: number;
    color: string | null;
    avatar: string | null;
  }

  const sliceActive = computed(() => !!view.value.sliceFieldId);
  const sliceFieldName = computed(() => {
    const key = view.value.sliceFieldId;
    return key ? fieldName(key) : "";
  });

  /** 左导航值行：字段值全列出（含计数），有缺值条目时追加「无 X」行。
   *  单选按选项序、数字/日期按值升序、负责人按计数降序（平台 zicowarn 10 →
   *  No Assignees 2 的实测序）。 */
  const sliceRows = computed<SliceRow[]>(() => {
    const key = view.value.sliceFieldId;
    if (!key) return [];
    const base = preSliceItems.value;
    if (key === "assignees") {
      const logins = new Set<string>();
      for (const i of base) for (const a of i.entity?.assignees ?? []) logins.add(a);
      const rows: SliceRow[] = [...logins].map((l) => ({
        value: l,
        label: l,
        description: null,
        count: base.filter((i) => (i.entity?.assignees ?? []).includes(l)).length,
        color: null,
        avatar: `https://github.com/${l}.png?size=40`,
      }));
      rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      const none = base.filter((i) => !(i.entity?.assignees ?? []).length).length;
      if (none) {
        rows.push({ value: "", label: t("project.columnNoValue", { field: fieldName("assignees") }), description: null, count: none, color: null, avatar: null });
      }
      return rows;
    }
    if (key === "repository") {
      const seen = new Map<string, string>();
      for (const i of base) if (i.repoId) seen.set(i.repoId, i.repoLabel ?? i.repoId);
      const rows: SliceRow[] = [...seen.entries()].map(([id, label]) => ({
        value: id,
        label,
        description: null,
        count: base.filter((i) => i.repoId === id).length,
        color: null,
        avatar: null,
      }));
      rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
      const none = base.filter((i) => !i.repoId).length;
      if (none) {
        rows.push({ value: "", label: t("project.columnNoValue", { field: t("project.colSource") }), description: null, count: none, color: null, avatar: null });
      }
      return rows;
    }
    const field = fieldByViewKey(key);
    if (!field) return [];
    if (field.kind === "builtin_status" || field.kind === "single_select") {
      const rows: SliceRow[] = field.options.map((o) => ({
        value: o.id,
        label: o.name,
        description: o.description ?? null,
        count: base.filter((i) => (i.fieldValues[field.id] ?? "") === o.id).length,
        color: o.color || null,
        avatar: null,
      }));
      if (base.some((i) => !i.fieldValues[field.id])) {
        rows.push({ value: "", label: t("project.columnNoValue", { field: fieldName(key) }), description: null, count: 0, color: null, avatar: null });
      }
      return rows;
    }
    // 数字 / 日期等自由值字段：取出现的去重值，按值升序
    const values = new Set<string>();
    for (const i of base) {
      const v = i.fieldValues[field.id] ?? "";
      if (v) values.add(v);
    }
    const rows: SliceRow[] = [...values].sort().map((v) => ({
      value: v,
      label: v,
      description: null,
      count: base.filter((i) => (i.fieldValues[field.id] ?? "") === v).length,
      color: null,
      avatar: null,
    }));
    if (base.some((i) => !i.fieldValues[field.id])) {
      rows.push({ value: "", label: t("project.columnNoValue", { field: fieldName(key) }), description: null, count: 0, color: null, avatar: null });
    }
    return rows;
  });

  /** 切片选中值归一：值失效（数据刷新后消失/切了字段）时自动落到第一个
   *  有条目的值——平台 Team items 始终有选中切片。 */
  function normalizeSlice() {
    const key = view.value.sliceFieldId;
    if (!key) return;
    if (view.value.sliceValue === null) return; // Deselect 后保持未选中
    const rows = sliceRows.value;
    if (!rows.length) {
      if (view.value.sliceValue) view.value.sliceValue = null;
      return;
    }
    if (rows.some((r) => r.value === view.value.sliceValue)) return;
    const hit = rows.find((r) => r.count > 0) ?? rows[0]!;
    view.value.sliceValue = hit.value;
  }
  watch(sliceRows, normalizeSlice);

  function setSliceField(key: string | null) {
    view.value.sliceFieldId = key;
    view.value.sliceValue = null;
    normalizeSlice();
  }
  function setSliceValue(value: string | null) {
    view.value.sliceValue = value;
  }
  function setSliceShowEmpty(show: boolean) {
    view.value.sliceShowEmpty = show;
  }

  /** Slice by 菜单候选（平台 12 项 → 按本项目数据模型收敛，见交付说明）：
   *  固定字段 Assignees/Status/Repository + 项目单选/数字/日期字段。 */
  const sliceFieldChoices = computed(() => {
    const out: { value: string; label: string; icon: string }[] = [
      { value: "assignees", label: fieldName("assignees"), icon: "o.people" },
      { value: "status", label: fieldName("status"), icon: "o.single-select" },
      { value: "repository", label: t("project.colSource"), icon: "o.repo" },
    ];
    for (const f of fields.value) {
      const key = viewKeyOfField(f);
      if (key === "status" || key === "priority") continue;
      const icon =
        f.kind === "single_select" ? "o.single-select"
        : f.kind === "number" ? "o.number"
        : f.kind === "date" ? "o.calendar"
        : null;
      if (!icon) continue;
      out.push({ value: key, label: f.name, icon });
    }
    // 优先级是单选字段但被上面 continue 跳过——按平台菜单位次补到自建字段之前
    const prio = fields.value.find((f) => viewKeyOfField(f) === "priority");
    if (prio) out.splice(3, 0, { value: "priority", label: t("project.colPriority"), icon: "o.single-select" });
    return out;
  });

  /** 列定义：分列字段的 options；有条目缺该字段值时追加「无」列（id = ""）。 */
  function columnOptions(): FieldOption[] {
    const field = columnField.value;
    if (!field) return [];
    const options = field.options;
    const hasEmpty = items.value.some((i) => !i.fieldValues[field.id]);
    return hasEmpty ? [...options, { id: "", name: "", color: "" }] : options;
  }

  async function loadProjects() {
    if (!isTauri()) return;
    try {
      projects.value = await api.projectList();
      if (!projects.value.some((p) => p.id === selectedId.value)) {
        selectedId.value = projects.value[0]?.id ?? null;
      }
      await loadSelected();
    } catch (e) {
      error.value = translateError(String(e));
    }
  }

  // ---- 甘特依赖边（容器真源泳道；随项目装载，写动作失败抛错由调用方提示） ----
  /** itemId → 被依赖条目 id 列表（投影合并平台镜像 ∪ 本地真源用）。 */
  const localDeps = ref<Record<string, string[]>>({});

  /** 资源目录（跨项目共享）与项目内分配（§5-bis）。 */
  const resourceCatalog = ref<Resource[]>([]);
  /** itemId → 分配行（资源 id + 占用比例）。 */
  const itemResources = ref<Record<string, { resourceId: string; allocation: number }[]>>({});

  async function loadResources() {
    if (!isTauri()) {
      resourceCatalog.value = [];
      return;
    }
    try {
      resourceCatalog.value = await api.resourceList();
    } catch {
      resourceCatalog.value = [];
    }
    if (!selectedId.value) {
      itemResources.value = {};
      return;
    }
    try {
      const rows = await api.itemResourceList(selectedId.value);
      const map: Record<string, { resourceId: string; allocation: number }[]> = {};
      for (const r of rows) {
        (map[r.itemId] ??= []).push({ resourceId: r.resourceId, allocation: r.allocation });
      }
      itemResources.value = map;
    } catch {
      itemResources.value = {};
    }
  }

  async function setItemResource(itemId: string, resourceId: string, allocation: number) {
    if (!selectedId.value) return;
    await api.itemResourceSet(selectedId.value, itemId, resourceId, allocation);
    await loadResources();
  }

  async function removeItemResource(itemId: string, resourceId: string) {
    if (!selectedId.value) return;
    await api.itemResourceRemove(selectedId.value, itemId, resourceId);
    await loadResources();
  }

  async function upsertResource(resource: Resource) {
    await api.resourceUpsert(resource);
    await loadResources();
  }

  /** 平台负责人 → 资源目录镜像（幂等）。 */
  async function syncResourceAssignees(origin: string, logins: string[]) {
    if (!logins.length) return;
    await api.resourceSyncAssignees(origin, logins);
    await loadResources();
  }

  /** 父子（结构扩展泳道）：itemId → 上级 itemId。随项目装载。 */
  const localParents = ref<Record<string, string>>({});

  async function loadParents() {
    if (!isTauri() || !selectedId.value) {
      localParents.value = {};
      return;
    }
    try {
      const rows = await api.projectParentList(selectedId.value);
      const map: Record<string, string> = {};
      for (const p of rows) map[p.itemId] = p.parentId;
      localParents.value = map;
    } catch {
      localParents.value = {};
    }
  }

  async function setItemParent(itemId: string, parentId: string) {
    if (!selectedId.value) return;
    await api.projectParentSet(selectedId.value, itemId, parentId);
    await loadParents();
  }

  async function clearItemParent(itemId: string) {
    if (!selectedId.value) return;
    await api.projectParentClear(selectedId.value, itemId);
    await loadParents();
  }

  async function syncPlatformParents(origin: string, edges: { itemId: string; dependsOn: string }[]) {
    if (!selectedId.value) return;
    await api.projectParentSyncPlatform(selectedId.value, origin, edges);
    await loadParents();
  }

  async function loadDeps() {
    if (!isTauri() || !selectedId.value) {
      localDeps.value = {};
      return;
    }
    try {
      const rows = await api.projectDepList(selectedId.value);
      const map: Record<string, string[]> = {};
      for (const d of rows) {
        (map[d.itemId] ??= []).push(d.dependsOn);
      }
      localDeps.value = map;
    } catch {
      localDeps.value = {}; // 读失败不阻塞面板（甘特按无本地依赖渲染）
    }
  }

  async function addItemDep(itemId: string, dependsOn: string) {
    if (!selectedId.value) return;
    await api.projectDepAdd(selectedId.value, itemId, dependsOn);
    await loadDeps();
  }

  async function removeItemDep(itemId: string, dependsOn: string) {
    if (!selectedId.value) return;
    await api.projectDepRemove(selectedId.value, itemId, dependsOn);
    await loadDeps();
  }

  /** 平台镜像整组同步（origin = 'gh'/'gitea'，按仓库来源定）：
   *  G1 拉取成功后调用——离线时甘特仍可读依赖（持久化镜像）。 */
  async function syncPlatformDeps(origin: string, edges: { itemId: string; dependsOn: string }[]) {
    if (!selectedId.value) return;
    await api.projectDepSyncPlatform(selectedId.value, origin, edges);
    await loadDeps();
  }

  /** 从项目移除条目（引用行删除；平台 Issue 本体不受影响——语义 =
   *  「从甘特/看板移除」，非关闭平台 Issue）。 */
  async function removeItemAndDeps(itemId: string) {
    if (!selectedId.value) return;
    await api.projectItemRemove(itemId);
    await loadSelected();
  }

  async function loadSelected() {
    if (!isTauri() || !selectedId.value) {
      fields.value = [];
      items.value = [];
      boundRepos.value = [];
      localDeps.value = {};
      return;
    }
    try {
      [fields.value, items.value, boundRepos.value] = await Promise.all([
        api.projectFields(selectedId.value),
        api.projectItemList(selectedId.value),
        api.projectRepoList(selectedId.value),
      ]);
      expandCatalogue();
      void loadDeps();
      void loadParents();
      void loadResources();
    } catch (e) {
      error.value = translateError(String(e));
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

  async function create(name: string, description?: string, connectionId?: string) {
    const p = await api.projectCreate(name, description, connectionId);
    projects.value = [p, ...projects.value];
    selectedId.value = p.id;
    await loadSelected();
  }

  /** 刷新项目数据：拉线上 ProjectsV2 条目落本地看板（返回导入/跳过计数）。 */
  async function syncSelected() {
    if (!selectedId.value || !isTauri()) return null;
    loading.value = true;
    try {
      const result = await api.projectSyncItems(selectedId.value);
      await loadProjects();
      await loadSelected();
      return result;
    } catch (e) {
      error.value = translateError(String(e));
      return null;
    } finally {
      loading.value = false;
    }
  }

  /** 导入线上项目：建本地项目并记录平台绑定（platformRef = 线上 URL，用于判重）。 */
  async function importRemote(args: {
    name: string;
    connectionId: string | null;
    platformKind: string;
    platformHost: string;
    platformRef: string;
  }) {
    const p = await api.projectImportRemote(args);
    projects.value = [p, ...projects.value];
    selectedId.value = p.id;
    await loadSelected();
    return p;
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
  /** 拖拽/换列的统一落点：后端算 rank 中值；分列字段由视图配置决定，
   * 「无」列（columnOptionId === ""）清空该字段值后只调整顺序。 */
  async function moveItem(itemId: string, columnOptionId?: string, prevId?: string, nextId?: string) {
    const field = columnField.value;
    if (!field) return;
    let optionId = columnOptionId;
    if (optionId === "") {
      await api.projectFieldValueSet(itemId, field.id);
      optionId = undefined;
    }
    const moved = await api.projectItemMove(
      itemId,
      view.value.columnFieldId ?? undefined,
      optionId,
      prevId,
      nextId,
    );
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

  return {
    projects,
    selectedId,
    selected,
    fields,
    items,
    boundRepos,
    loading,
    error,
    publishError,
    publishColumns,
    navRequest,
    panelItemId,
    panelItem,
    openPanelItem,
    closePanelItem,
    statusField,
    priorityField,
    columnField,
    columnFieldChoices,
    columnOptions,
    swimlaneField,
    swimlaneOptions,
    numberFields,
    columnSums,
    setSwimlaneFieldId,
    toggleSum,
    fieldCatalogue,
    fieldName,
    fieldByViewKey,
    cellOf,
    createField,
    setFieldValue,
    view,
    views,
    activeView,
    activeViewId,
    layout,
    setActiveView,
    setLayout,
    addView,
    renameView,
    moveView,
    duplicateView,
    deleteView,
    filteredItems,
    sliceActive,
    sliceFieldName,
    sliceRows,
    sliceFieldChoices,
    setSliceField,
    setSliceValue,
    setSliceShowEmpty,
    setSortBy,
    setSortDesc,
    setColumnFieldId,
    setDateEndFieldId,
    setMarkersMilestones,
    setMarkersStartDate,
    setMarkersDueDate,
    roadmapMilestoneMeta,
    loadRoadmapMilestones,
    localDeps,
    localParents,
    resourceCatalog,
    itemResources,
    loadResources,
    setItemResource,
    removeItemResource,
    upsertResource,
    syncResourceAssignees,
    setItemParent,
    clearItemParent,
    syncPlatformParents,
    addItemDep,
    removeItemDep,
    syncPlatformDeps,
    removeItemAndDeps,
    setFieldSort,
    addFieldFilter,
    toggleField,
    loadProjects,
    loadAll,
    refreshSelected: loadSelected,
    select,
    create,
    importRemote,
    syncSelected,
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
    updateOption,
    addOption,
    deleteOption,
    moveOption,
    removeItemsIn,
    toggleHidden,
    isHidden,
    setColumnLimit,
    laneSums,
    toggleLaneCollapsed,
    isLaneCollapsed,
  };
});
