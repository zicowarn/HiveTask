<script setup lang="ts">
/**
 * Board view — columns come from the builtin_status field's options (the
 * data-defined workflow, not hardcoded columns); cards drag between/within
 * columns (HTML5 DnD → backend computes a fractional rank midpoint).
 * Card body: draft title or `#number title` with a repo/ghost tag; priority
 * renders as a colored dot from the single-select field's option color.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useProjectsStore } from "../../stores/projects";
import { api, type FieldOption, type ProjectField, type ProjectItem } from "../../api";
import { useI18n } from "../../i18n";
import DropdownMenu from "../../components/DropdownMenu.vue";
import ActionMenu, { type ActionItem } from "../../components/ActionMenu.vue";
import EditorIcon from "../../components/EditorIcon.vue";
import { chipColors, type ChipColors } from "../field-chip";
import IssueCreateDialog from "../IssueCreateDialog.vue";
import ProjectAddItemsDrawer from "../ProjectAddItemsDrawer.vue";
import ProjectOmnibar from "../ProjectOmnibar.vue";
import OptionEditDialog from "../OptionEditDialog.vue";
import { pushToast } from "../../toast";
import { itemTitle } from "../item-fields";

const store = useProjectsStore();
const { selected, filteredItems } = storeToRefs(store);
const { t } = useI18n();

/** 列头行实测高度 = 泳道组头的吸顶 top（平台：组头钉在列头行正下方，零间隙）。
 * 列描述行有无/i18n 都会影响高度，故用 ResizeObserver 实测而非写死。 */
const boardHeadsEl = ref<HTMLElement | null>(null);
const headsH = ref(0);
let headsRO: ResizeObserver | null = null;
watch(boardHeadsEl, (el) => {
  headsRO?.disconnect();
  headsRO = null;
  if (!el) return;
  headsH.value = el.offsetHeight;
  headsRO = new ResizeObserver(() => {
    headsH.value = el.offsetHeight;
  });
  headsRO.observe(el);
});

onBeforeUnmount(() => {
  headsRO?.disconnect();
});

/** 是否分泳道：分泳道时列头抽成单独一行、泳道为带（平台形态）；不分时保持列盒（Backlog 现状）。
 *  泳道字段与分列字段同字段时退化（Team items 视图二者同为 Status——自身 × 自身无意义），
 *  按不分泳道渲染（③适配标注：平台 Board 布局无泳道概念，此处是本实现的守卫）。 */
const laneMode = computed(() => {
  const lane = store.swimlaneField;
  return !!lane && lane.id !== store.columnField?.id;
});

/** 列 = 视图「分列方式」字段的选项（含条目缺值时的「无」列；隐藏列剔除）。 */
const columns = computed(() => store.columnOptions().filter((o) => !store.isHidden("column", o.id)));

/** 泳道段 = 视图「泳道」字段的选项；不分泳道时退化为单段（laneId = null）。 */
const lanes = computed<{ id: string | null; name: string; color: string | null }[]>(() => {
  const field = store.swimlaneField;
  if (!field) return [{ id: null, name: "", color: null }];
  return store.swimlaneOptions()
    .filter((o) => !store.isHidden("lane", o.id))
    .map((o) => ({
      id: o.id,
      name: o.id === "" ? t("project.columnNoValue", { field: field.name }) : o.name,
      color: o.color || null,
    }));
});

// ---- 列 / 泳道组的 ⋯ 菜单（对齐 GitHub 的 Actions：分组 + 危险项）----
type MenuTarget = { kind: "column" | "lane"; optionId: string; name: string };

function columnMenuItems(target: MenuTarget) {
  const at = columns.value.findIndex((c) => c.id === target.optionId);
  return [
    { value: "edit", label: t("project.actEdit"), group: t("project.actGroupColumn"), icon: "o.edit" },
    { value: "limit", label: t("project.actLimit"), group: t("project.actGroupColumn"), icon: "o.limit" },
    { value: "hide", label: t("project.actHide"), group: t("project.actGroupColumn"), icon: "o.hide" },
    { value: "delete", label: t("project.actDelete"), group: t("project.actGroupColumn"), danger: true, icon: "o.trash" },
    { value: "removeAll", label: t("project.actRemoveAll"), group: t("project.actGroupItems"), danger: true, icon: "o.trash" },
    ...(at > 0
      ? [{ value: "left", label: t("project.actMoveLeft"), group: t("project.actGroupPosition"), icon: "o.arrow-left" }]
      : []),
    ...(at >= 0 && at < columns.value.length - 1
      ? [{ value: "right", label: t("project.actMoveRight"), group: t("project.actGroupPosition"), icon: "o.arrow-right" }]
      : []),
  ];
}
function laneMenuItems() {
  return [
    { value: "edit", label: t("project.actEdit"), group: t("project.actGroupLane"), icon: "o.edit" },
    { value: "hide", label: t("project.actHide"), group: t("project.actGroupLane"), icon: "o.hide" },
    { value: "delete", label: t("project.actDelete"), group: t("project.actGroupLane"), danger: true, icon: "o.trash" },
    { value: "removeAll", label: t("project.actRemoveAll"), group: t("project.actGroupItems"), danger: true, icon: "o.trash" },
  ];
}

/** 段头 ⋯ / 列头 ⋯ 共用：目标字段取当前分列或泳道字段。 */
async function onMenuPick(target: MenuTarget, value: string) {
  const field = target.kind === "column" ? store.columnField : store.swimlaneField;
  if (!field) return;
  switch (value) {
    case "edit":
      openEdit(target, field.id);
      break;
    case "limit":
      openLimit(target);
      break;
    case "hide":
      store.toggleHidden(target.kind, target.optionId);
      break;
    case "delete":
      if (confirm(t("project.actDeleteConfirm", { name: target.name }))) {
        await store.deleteOption(field.id, target.optionId);
      }
      break;
    case "removeAll":
      if (confirm(t("project.actRemoveAllConfirm", { name: target.name }))) {
        await store.removeItemsIn(field.id, target.optionId);
      }
      break;
    case "left":
      await store.moveOption(field.id, target.optionId, -1);
      break;
    case "right":
      await store.moveOption(field.id, target.optionId, 1);
      break;
  }
}

// ---- omnibar 菜单的两条「完整路径」（平台：点菜单项开容器）----
// ① Create new issue → 模态对话框（复用 IssueCreateDialog）
// ② Add item from repository → 右侧抽屉（ProjectAddItemsDrawer）
// 内联快路径（输入 # → 仓库 → 点选单条）保留，二者并存与平台一致。
const createOpen = ref(false);
const drawerOpen = ref(false);
const repoMenu = ref<{ value: string; label: string; target: string; visibility: string | null }[]>([]);
const repoChoices = ref<
  { id: string; label: string; visibility?: string | null; target: string; remoteUrl?: string | null }[]
>([]);
async function ensureRepos() {
  if (repoChoices.value.length) return;
  try {
    const rows = (await api.repoList()) as Array<{ id: string; displayName?: string | null; path?: string | null; remoteUrl?: string | null; visibility?: string | null }>;
    repoChoices.value = rows.map((r) => ({
      id: r.id,
      label: r.displayName ?? r.path?.split("/").filter(Boolean).pop() ?? r.remoteUrl ?? r.id,
      visibility: r.visibility ?? null,
      target: r.path ?? r.remoteUrl ?? r.id,
      remoteUrl: r.remoteUrl ?? null,
    }));
  } catch {
    repoChoices.value = [];
  }
}
/** 仓库候选：项目绑定优先，不足则并入全部登记仓库。 */
async function ensureRepoMenu() {
  await ensureRepos();
  const all = repoChoices.value.map((r) => ({
    value: r.id,
    label: r.label,
    target: r.target,
    visibility: r.visibility ?? null,
  }));
  const bound = store.boundRepos
    .filter((b) => !!b.target)
    .map((b) => ({
      value: b.repoId,
      label: b.label,
      target: b.target,
      visibility: all.find((a) => a.value === b.repoId)?.visibility ?? null,
    }));
  const merged = [...bound];
  for (const r of all) if (!merged.some((m) => m.value === r.value)) merged.push(r);
  repoMenu.value = merged;
}
function openCreateDialog() {
  omni.value?.close(); // 收起 omnibar，但保留 addColumn/addLane 目标格
  void ensureRepoMenu();
  createOpen.value = true;
}
function openAddItemsDrawer() {
  omni.value?.close();
  void ensureRepoMenu();
  drawerOpen.value = true;
}
/** 新建 Issue 成功 → 作为引用条目落入目标格（平台同款：从看板创建的 Issue 直接入板）。 */
async function onIssueCreated(payload: { number: string; repoId: string }) {
  if (!selected.value) return;
  const created = await store.addItem({
    projectId: selected.value.id,
    kind: "issue",
    repoId: payload.repoId,
    number: payload.number,
  });
  if (created) {
    const col = addColumn.value ?? columns.value[0]?.id ?? null;
    if (col !== null) await store.moveItem(created.id, col);
    const lane = store.swimlaneField;
    if (lane && addLane.value !== null) {
      await store.setFieldValue(created.id, lane.id, addLane.value === "" ? undefined : addLane.value);
    }
  }
  addLane.value = null;
}

// ---- 草稿卡就地编辑（平台：草稿卡的标题可直接改）----
const editingDraft = ref<string | null>(null);
async function saveDraftTitle(item: ProjectItem, title: string) {
  editingDraft.value = null;
  if (!title.trim()) return;
  await store.updateDraft(item.id, title.trim(), item.draftBody ?? "");
}

/** 列头行最右的「Add a new column」：给分列字段追加选项，随即打开 Edit option 命名。 */
async function addColumnOption() {
  const field = store.columnField;
  if (!field) return;
  const name = t("project.newColumnName", { n: String(field.options.length + 1) });
  const option = await store.addOption(field.id, name);
  if (option) {
    openEdit({ kind: "column", optionId: option.id, name: option.name }, field.id, "new");
  }
}

// ---- 看板右上「＋」= 平台的列菜单（+ New column / Visible columns / Hidden columns）----
/** 选中态 = 可见列（dropdown 的 modelValue）；pick 回传整份列表，按差集切换隐藏态。 */
const visibleColumnIds = computed(() =>
  store.columnOptions().filter((o) => !store.isHidden("column", o.id)).map((o) => o.id),
);
const columnSections = computed(() => {
  const all = store.columnOptions();
  const rows = (list: typeof all) =>
    list.map((o) => ({ value: o.id, label: columnName(o) }));
  const visible = rows(all.filter((o) => !store.isHidden("column", o.id)));
  const hidden = rows(all.filter((o) => store.isHidden("column", o.id)));
  const out: { title: string; options: { value: string; label: string }[] }[] = [];
  if (visible.length) out.push({ title: t("project.visibleColumns"), options: visible });
  if (hidden.length) out.push({ title: t("project.hiddenColumns"), options: hidden });
  return out;
});
function onColumnMenuAction(value: string) {
  if (value === "newColumn") void addColumnOption();
}
function onColumnVisibility(next: string | string[]) {
  const list = Array.isArray(next) ? next : [next];
  for (const option of store.columnOptions()) {
    const shouldShow = list.includes(option.id);
    if (shouldShow === store.isHidden("column", option.id)) store.toggleHidden("column", option.id);
  }
}

// ---- 编辑详情（Edit option）/ 设置上限：弹层（GitHub 同为弹层表单）----
const editTarget = ref<{ target: MenuTarget; fieldId: string } | null>(null);
/** 对话框标题两态：新建走「New option」，既有选项走「Edit option」。 */
const editMode = ref<"new" | "edit">("edit");
const limitTarget = ref<MenuTarget | null>(null);
const limitValue = ref("");

function findOption(fieldId: string, optionId: string) {
  return store.fields.find((f) => f.id === fieldId)?.options.find((o) => o.id === optionId) ?? null;
}
function openEdit(target: MenuTarget, fieldId: string, mode: "new" | "edit" = "edit") {
  editMode.value = mode;
  editTarget.value = { target, fieldId };
}
async function submitEdit(payload: { name: string; color: string; description: string }) {
  const ctx = editTarget.value;
  if (!ctx) return;
  await store.updateOption(ctx.fieldId, ctx.target.optionId, payload);
  editTarget.value = null;
}
function openLimit(target: MenuTarget) {
  limitTarget.value = target;
  limitValue.value = String(store.view.columnLimits[target.optionId] ?? "");
}
function submitLimit() {
  const target = limitTarget.value;
  if (!target) return;
  store.setColumnLimit(target.optionId, Number(limitValue.value) || 0);
  limitTarget.value = null;
}
/** 列说明（GitHub 在列头下显示选项说明）。 */
function columnDescription(col: FieldOption): string {
  const field = store.columnField;
  if (!field) return "";
  return field.options.find((o) => o.id === col.id)?.description ?? "";
}
/** 列头计数：有上限时显示「计数 / 上限」（GitHub 同款）。 */
function columnCount(optionId: string, laneId: string | null): string {
  const n = cardsOf(optionId, laneId).length;
  const limit = store.view.columnLimits[optionId];
  return limit ? `${n} / ${limit}` : String(n);
}

/** 段 → 该段内的列卡片（按分列字段与泳道字段双维过滤）。 */
function cardsOf(optionId: string, laneId: string | null) {
  const column = store.columnField;
  const lane = store.swimlaneField;
  if (!column) return [];
  return filteredItems.value.filter((i) => {
    const colHit = (i.fieldValues[column.id] ?? "") === optionId;
    const laneHit = !lane || laneId === null ? true : (i.fieldValues[lane.id] ?? "") === laneId;
    return colHit && laneHit;
  });
}

/** 列名：「无」列按分列字段名渲染（对齐 GitHub 的 No <Field>）。 */
function columnName(col: FieldOption): string {
  if (col.id !== "") return col.name;
  return t("project.columnNoValue", { field: store.columnField?.name ?? "" });
}

/** 显示字段开关（视图「字段」；自建字段用其 id）。 */
const shows = (id: string) => store.view.fields.includes(id as never);
/** 计数 pill（平台的 CounterLabel）随视图的「Field sum: Count」开关显示。 */
const showsCount = computed(() => store.view.sumFieldIds.includes("count"));






// ---- 卡片点击：打开右侧 item 抽屉（平台形态；面板挂在 ProjectPanel）----
function openCard(item: ProjectItem) {
  store.openPanelItem(item.id);
}

// ---- 卡片形态（平台实测）：状态图标 + `仓库 #编号` + 负责人头像 / 标题 / 字段 pill 行 ----
/** 状态图标：Issue 开/闭（绿/紫）；PR 用 PR 图标；草稿无（平台草稿态未取证）。 */
function stateIconOf(item: ProjectItem): string | null {
  if (item.kind === "draft") return null;
  if (item.kind === "pull") return "pull";
  const state = (item.entity?.state ?? "").toUpperCase();
  return state === "CLOSED" ? "o.issue-closed" : "o.issue-opened";
}
/** 状态色：开 = success 绿、关/合并 = merged 紫（平台实测 #1A7F37 / #8250DF）。 */
function stateColorOf(item: ProjectItem): string {
  const state = (item.entity?.state ?? "").toUpperCase();
  return state === "CLOSED" || state === "MERGED" ? "var(--merged)" : "var(--success)";
}
/** 元信息行第二段：`仓库 #编号`。 */
function refOf(item: ProjectItem): string {
  if (item.ghost) return t("project.ghost");
  if (item.kind === "draft") return t("project.draftTag");
  const label = item.repoLabel ?? "";
  return item.number ? `${label} #${item.number}` : label;
}
/** 负责人头像（平台：卡片右上 20px 圆；取首个负责人）。 */
function avatarOf(item: ProjectItem): string | null {
  const login = item.entity?.assignees?.[0];
  return login ? `https://github.com/${login}.png?size=40` : null;
}
/** 卡片字段 chip（平台形态与顺序，2026-09-16 取证）：
 * 顺序 = **视图的字段顺序**（线上 Backlog 视图 = Priority, Estimate, Size，与卡片一致；
 * GraphQL 的 visibleFields 只是规范化顺序，不是这个）；值 = 本地字段值；空值不出 chip；
 * 分列字段与泳道字段不上卡（它们的值就是卡片的位置）。数字/文本/日期字段用 neutral 组。 */
function cardPills(item: ProjectItem): { key: string; text: string; tip: string; chip: ChipColors }[] {
  const skip = new Set<string>();
  if (store.columnField) skip.add(viewKeyOf(store.columnField));
  if (store.swimlaneField) skip.add(viewKeyOf(store.swimlaneField));
  const out: { key: string; text: string; tip: string; chip: ChipColors }[] = [];
  for (const key of store.view.fields) {
    if (skip.has(key)) continue;
    const field = store.fieldByViewKey(key);
    if (!field) continue; // 条目自身 / 引用实体镜像字段不上卡（平台同）
    // 日期字段不上看板卡（平台取证：卡片只有选项/数字 chip，日期属于 Table / Roadmap）
    if (!["single_select", "number", "text"].includes(field.kind)) continue;
    const value = fieldValueText(item, field);
    if (!value) continue;
    out.push({
      key,
      text: value,
      tip: `${field.name}: ${value}`,
      chip: chipColors(optionColorOf(item, field)),
    });
  }
  return out;
}

/** 视图键（与 store.view.fields 同口径）。 */
function viewKeyOf(field: ProjectField): string {
  if (field.kind === "builtin_status") return "status";
  return field.id;
}

/** 字段值文本：单选给选项名（无值时 null），数字/文本/日期给原值。 */
function fieldValueText(item: ProjectItem, field: ProjectField): string | null {
  const raw = item.fieldValues[field.id] ?? "";
  if (!raw) return null;
  if (field.kind === "single_select" || field.kind === "builtin_status") {
    return field.options.find((o) => o.id === raw)?.name ?? null;
  }
  return raw;
}

/** 单选字段的选项色（chip 配色的输入）；非单选返回 null（neutral 组）。 */
function optionColorOf(item: ProjectItem, field: ProjectField): string | null {
  if (field.kind !== "single_select" && field.kind !== "builtin_status") return null;
  const raw = item.fieldValues[field.id] ?? "";
  return field.options.find((o) => o.id === raw)?.color ?? null;
}

/** 引用条目的线上地址（remote + issues|pull + 编号）；本地库 / 草稿 / 悬挂为空。 */
function issueUrlOf(item: ProjectItem): string | null {
  if (item.kind === "draft" || !item.repoId || !item.number) return null;
  void ensureRepos();
  const remote = repoChoices.value.find((r) => r.id === item.repoId)?.remoteUrl ?? "";
  if (!/^https?:\/\//.test(remote)) return null;
  const base = remote.replace(/\.git$/, "").replace(/\/+$/, "");
  return `${base}/${item.kind === "pull" ? "pull" : "issues"}/${item.number}`;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    pushToast({ kind: "info", message: t("project.copied") });
  } catch {
    pushToast({ kind: "error", message: t("project.copyFailed") });
  }
}

/** 卡片 ⋯ 菜单。平台另有 Copy link in project / Archive——前者需项目线上地址、
 * 后者需归档字段，均无数据面，按「不摆空控件」挂账。
 * 「在新标签页中打开」是浏览器语境动作，桌面端不落（用户定案 2026-09-16）。 */
function cardMenuItems(item: ProjectItem): ActionItem[] {
  const out: ActionItem[] = [];
  if (issueUrlOf(item)) {
    out.push({ value: "copyLink", label: t("project.actCopyLink"), icon: "o.copy" });
  }
  const cols = columns.value;
  if (item.kind !== "draft" && cols.length > 1) {
    out.push({
      value: "move",
      label: t("project.actMoveToColumn"),
      icon: "o.arrow-both",
      dividerBefore: out.length > 0,
      submenu: cols
        .filter((c) => c.id !== (item.fieldValues[store.columnField?.id ?? ""] ?? ""))
        .map((c) => ({ value: `move:${c.id}`, label: columnName(c) })),
    });
  }
  out.push({
    value: "remove",
    label: t("project.actRemoveFromProject"),
    icon: "o.trash",
    danger: true,
    badge: "Del",
    dividerBefore: out.length > 0,
  });
  return out;
}

async function onCardMenuPick(item: ProjectItem, value: string) {
  if (value === "copyLink") {
    const url = issueUrlOf(item);
    if (url) await copyText(url);
    return;
  }
  if (value.startsWith("move:")) {
    await store.moveItem(item.id, value.slice(5));
    return;
  }
  if (value === "remove") await store.removeItem(item.id);
}

// ---- 拖拽：dragover 记录落点（泳道段 + 列 + 参照卡），drop 一次性提交 ----
const dragId = ref<string | null>(null);
const dropTarget = ref<{ laneId: string | null; optionId: string; prevId: string | null } | null>(null);

function onDragStart(item: ProjectItem, event: DragEvent) {
  dragId.value = item.id;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.id);
  }
}
function onDragOverColumn(laneId: string | null, optionId: string, event: DragEvent) {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTarget.value = { laneId, optionId, prevId: lastCardId(optionId, laneId) };
}
function onDragOverCard(laneId: string | null, optionId: string, item: ProjectItem, event: DragEvent) {
  if (dragId.value === item.id) return;
  event.preventDefault();
  event.stopPropagation();
  dropTarget.value = { laneId, optionId, prevId: item.id };
}
async function onDrop(event: DragEvent) {
  event.preventDefault();
  const id = dragId.value;
  const target = dropTarget.value;
  dragId.value = null;
  dropTarget.value = null;
  if (!id || !target) return;
  await store.moveItem(id, target.optionId, target.prevId ?? undefined, undefined);
  // 跨泳道拖动：落点段与当前段不同则同时改写泳道字段（「无」段 = 清空）
  const lane = store.swimlaneField;
  if (lane && target.laneId !== null) {
    await store.setFieldValue(id, lane.id, target.laneId === "" ? undefined : target.laneId);
  }
}
function lastCardId(optionId: string, laneId: string | null): string | null {
  const cards = cardsOf(optionId, laneId);
  return cards.length ? cards[cards.length - 1]!.id : null;
}

/** 泳道段内的条目总数（段头计数）。 */
function laneTotal(laneId: string | null): number {
  return columns.value.reduce((n, col) => n + cardsOf(col.id, laneId).length, 0);
}

// ---- 添加条目：GitHub 的底部 omnibar（共享组件 ProjectOmnibar）----
const addColumn = ref<string | null>(null);
const addLane = ref<string | null>(null);
const omni = ref<InstanceType<typeof ProjectOmnibar> | null>(null);
/** omnibar 开关（目标格指示条 omni-target-bar 需要）。 */
const omniOpen = ref(false);

/** 目标格：由列头 ＋ / 段头 ＋ / 格底 Add item 指定；打开输入条并锁定该格。 */
function quickAdd(optionId: string, laneId: string | null = null) {
  // 再点同一格的 ＋ = 收起（切换语义，与 Table/Roadmap 一致）；点其他格 = 改投目标。
  // ＋ 触发点在 omnibar 打开期间都标 data-omni-host（外点关闭豁免），
  // 否则 pointerdown 先关、click 再开，永远关不掉（点击异常实测翻车）
  if (omniOpen.value && addColumn.value === optionId && addLane.value === laneId) {
    omni.value?.close();
    addColumn.value = null;
    addLane.value = null;
    return;
  }
  addColumn.value = optionId;
  addLane.value = laneId;
  omni.value?.open();
}
/** omnibar 回车建草稿 → 落入目标格（列/泳道由 quickAdd 锁定）。 */
async function onOmnibarDraft(title: string) {
  if (!selected.value) return;
  const created = await store.addItem({ projectId: selected.value.id, kind: "draft", draftTitle: title });
  if (created) {
    const col = addColumn.value ?? columns.value[0]?.id ?? null;
    if (col !== null) await store.moveItem(created.id, col);
    const lane = store.swimlaneField;
    if (lane && addLane.value !== null) {
      await store.setFieldValue(created.id, lane.id, addLane.value === "" ? undefined : addLane.value);
    }
  }
}
/** omnibar 点选 Issue → 以引用卡加入目标格。 */
async function onOmnibarIssue(payload: { repoId: string; number: string }) {
  if (!selected.value) return;
  const created = await store.addItem({
    projectId: selected.value.id,
    kind: "issue",
    repoId: payload.repoId,
    number: payload.number,
  });
  if (created) {
    const col = addColumn.value ?? columns.value[0]?.id ?? null;
    if (col !== null) await store.moveItem(created.id, col);
    const lane = store.swimlaneField;
    if (lane && addLane.value !== null) {
      await store.setFieldValue(created.id, lane.id, addLane.value === "" ? undefined : addLane.value);
    }
  }
}

// ---- 草稿转 Issue ----
const converting = ref<string | null>(null);
const localRepos = ref<{ path: string; label: string }[]>([]);
async function toggleConvert(item: ProjectItem) {
  converting.value = converting.value === item.id ? null : item.id;
  if (converting.value && localRepos.value.length === 0) {
    try {
      const rows = (await api.repoList()) as Array<{ path?: string | null; displayName?: string | null; remoteUrl?: string | null }>;
      localRepos.value = rows
        .filter((r) => r.path && !r.remoteUrl)
        .map((r) => ({ path: r.path!, label: r.displayName ?? r.path!.split("/").filter(Boolean).pop()! }));
    } catch {
      localRepos.value = [];
    }
  }
}
async function submitConvert(item: ProjectItem, path: string) {
  await store.convertToIssue(item.id, path);
  converting.value = null;
}
</script>

<template>
  <div class="board-wrap" @drop="onDrop" @dragover.prevent>
  <div class="board" :style="{ '--heads-h': `${headsH}px` }">
   <div class="board-flow">
    <!-- 分泳道时：列头单独一行（平台的列头行），最右是「Add a new column」；
         整板滚动时吸顶常驻（平台行为），泳道组头钉在它正下方 -->
    <div v-if="laneMode" ref="boardHeadsEl" class="board-heads">
      <div v-for="col in columns" :key="col.id" class="head-cell">
        <div class="col-head">
          <span
            v-if="col.color"
            class="col-dot"
            :style="{ background: chipColors(col.color).bg, color: col.color }"
          ></span>
          <h2 class="col-name">{{ columnName(col) }}</h2>
          <span v-if="showsCount" class="col-count">{{ columnCount(col.id, null) }}</span>
          <span v-for="sum in store.columnSums(col.id, null)" :key="sum.label" class="col-sum">
            {{ sum.label }}: {{ sum.value }}
          </span>
          <span class="col-spacer"></span>
          <ActionMenu
            v-if="col.id"
            trigger-icon="ellipsis"
            :title="t('project.actColumnMenu')"
            :items="columnMenuItems({ kind: 'column', optionId: col.id, name: columnName(col) })"
            @pick="onMenuPick({ kind: 'column', optionId: col.id, name: columnName(col) }, $event)"
          />
          <button
            class="col-btn plus"
            :title="t('project.addHere')"
            :data-omni-host="omniOpen ? '' : undefined"
            @click="quickAdd(col.id, lanes[0]?.id ?? null)"
          >＋</button>
        </div>
        <p v-if="columnDescription(col)" class="col-desc">{{ columnDescription(col) }}</p>
      </div>
  <!-- 列流末尾的「＋」= 平台的列菜单（New column / Visible / Hidden columns）；
       永远紧跟最后一列右侧，随列行一起滚动（平台行为，非悬浮） -->
  <DropdownMenu
    class="board-add-dd"
    :action="{ value: 'newColumn', label: t('project.newColumn'), icon: 'o.plus' }"
    :sections="columnSections"
    :model-value="visibleColumnIds"
    multiple
    @action="onColumnMenuAction"
    @update:model-value="onColumnVisibility"
  >
    <template #trigger="{ toggle, open }">
      <button
        class="board-add"
        type="button"
        :class="{ on: open }"
        :title="t('project.newColumn')"
        @click="toggle"
      >
        <EditorIcon name="o.plus" />
      </button>
    </template>
  </DropdownMenu>
    </div>

    <div v-for="lane in lanes" :key="lane.id ?? '__none__'" class="lane" :class="{ 'lane-fill': !laneMode }">
      <p v-if="lane.name" class="lane-head">
        <button
          class="lane-collapse"
          type="button"
          :title="store.isLaneCollapsed(lane.id ?? '') ? t('project.expandLane') : t('project.collapseLane')"
          @click="store.toggleLaneCollapsed(lane.id ?? '')"
        >
          <EditorIcon :name="store.isLaneCollapsed(lane.id ?? '') ? 'chevron' : 'o.chevron-down'" />
        </button>
        <span
          v-if="lane.color"
          class="col-dot"
          :style="{ background: chipColors(lane.color).bg, color: lane.color }"
        ></span>
        {{ lane.name }}
        <span class="col-count">{{ laneTotal(lane.id) }}</span>
        <span v-for="sum in store.laneSums(lane.id ?? '')" :key="sum.label" class="col-sum">
          {{ sum.label }}: {{ sum.value }}
        </span>
        <ActionMenu
          v-if="lane.id"
          trigger-icon="ellipsis"
          :title="t('project.actLaneMenu')"
          :items="laneMenuItems()"
          @pick="onMenuPick({ kind: 'lane', optionId: lane.id ?? '', name: lane.name }, $event)"
        />
      </p>
      <div v-if="!store.isLaneCollapsed(lane.id ?? '')" class="lane-cols">
        <div
          v-for="col in columns"
          :key="col.id"
          class="col"
          :class="{ 'cell-plain': laneMode }"
          @dragover="onDragOverColumn(lane.id, col.id, $event)"
        >
          <div v-if="!laneMode" class="col-head">
            <span
            v-if="col.color"
            class="col-dot"
            :style="{ background: chipColors(col.color).bg, color: col.color }"
          ></span>
            <h2 class="col-name">{{ columnName(col) }}</h2>
            <span v-if="showsCount" class="col-count">{{ columnCount(col.id, lane.id) }}</span>
            <span v-for="sum in store.columnSums(col.id, lane.id)" :key="sum.label" class="col-sum">
              {{ sum.label }}: {{ sum.value }}
            </span>
            <span class="col-spacer"></span>
            <ActionMenu
              v-if="col.id"
              trigger-icon="ellipsis"
              :title="t('project.actColumnMenu')"
              :items="columnMenuItems({ kind: 'column', optionId: col.id, name: columnName(col) })"
              @pick="onMenuPick({ kind: 'column', optionId: col.id, name: columnName(col) }, $event)"
            />
            <button
              class="col-btn plus"
              :title="t('project.addHere')"
              :data-omni-host="omniOpen ? '' : undefined"
              @click="quickAdd(col.id, lanes[0]?.id ?? null)"
            >＋</button>
          </div>
          <p v-if="!laneMode && columnDescription(col)" class="col-desc">{{ columnDescription(col) }}</p>
          <div class="col-body" :class="{ 'col-scroll': !laneMode }">
          <span
            v-if="omniOpen && addColumn === col.id && addLane === lane.id"
            class="omni-target-bar"
          ></span>
          <div
            v-for="card in cardsOf(col.id, lane.id)"
            :key="card.id"
            class="card"
            :class="{ ghosty: card.ghost, dropping: dropTarget?.prevId === card.id, clickable: true }"
            role="button"
            tabindex="0"
            :aria-label="itemTitle(card)"
            draggable="true"
            @dragstart="onDragStart(card, $event)"
            @dragover="onDragOverCard(lane.id, col.id, card, $event)"
            @click="openCard(card)"
            @keydown.enter.prevent="openCard(card)"
          >
        <p class="card-meta">
          <EditorIcon
            v-if="stateIconOf(card)"
            class="card-state"
            :name="stateIconOf(card)!"
            :style="{ color: stateColorOf(card) }"
          />
          <span class="card-ref">{{ refOf(card) }}</span>
          <!-- 平台：⋯ 常显、紧跟 #编号 右侧；行最右端是负责人头像 -->
          <ActionMenu
            class="card-menu"
            trigger-icon="ellipsis"
            :title="t('project.actItemMenu')"
            :items="cardMenuItems(card)"
            @pick="onCardMenuPick(card, $event)"
          />
          <span class="card-spacer"></span>
          <img v-if="avatarOf(card)" class="card-avatar" :src="avatarOf(card)!" alt="" />
        </p>
        <input
          v-if="shows('title') && editingDraft === card.id"
          class="card-title-input"
          :value="card.draftTitle ?? ''"
          @click.stop
          @keydown.enter="saveDraftTitle(card, ($event.target as HTMLInputElement).value)"
          @blur="editingDraft = null"
        />
        <p
          v-else-if="shows('title')"
          class="card-title"
          @click="card.kind === 'draft' && $event.stopPropagation()"
          @dblclick="card.kind === 'draft' && (editingDraft = card.id)"
        >{{ itemTitle(card) }}</p>
        <p v-if="cardPills(card).length" class="card-pills">
          <span
            v-for="pill in cardPills(card)"
            :key="pill.key"
            class="card-pill"
            :title="pill.tip"
            :style="{ background: pill.chip.bg, color: pill.chip.fg, borderColor: pill.chip.border }"
          >{{ pill.text }}</span>
        </p>
        <div v-if="card.kind === 'draft'" class="card-convert" @click.stop>
          <button class="card-link" @click="toggleConvert(card)">{{ t("project.convert") }}</button>
          <template v-if="converting === card.id">
            <DropdownMenu
              class="card-dd"
              :options="localRepos.map((r) => ({ value: r.path, label: r.label }))"
              :model-value="''"
              :placeholder="t('project.pickLocalRepo')"
              @update:model-value="((converting = null), submitConvert(card, $event as string))"
            />
          </template>
        </div>
        </div>
        <button
          class="cell-add"
          type="button"
          :class="{ target: omniOpen && addColumn === col.id && addLane === lane.id }"
          :title="t('project.addItemRow')"
          :data-omni-host="omniOpen ? '' : undefined"
          @click="quickAdd(col.id, lane.id)"
        >
          <EditorIcon name="o.plus" />
          <span>{{ t("project.addItemRow") }}</span>
        </button>
        <p
          v-if="dropTarget?.laneId === lane.id && dropTarget?.prevId === null"
          class="drop-hint"
        >↓</p>
          </div>
        </div>
  <!-- 列流末尾的「＋」= 平台的列菜单（New column / Visible / Hidden columns）；
       永远紧跟最后一列右侧，随列行一起滚动（平台行为，非悬浮） -->
  <DropdownMenu
    v-if="!laneMode"
    class="board-add-dd"
    :action="{ value: 'newColumn', label: t('project.newColumn'), icon: 'o.plus' }"
    :sections="columnSections"
    :model-value="visibleColumnIds"
    multiple
    @action="onColumnMenuAction"
    @update:model-value="onColumnVisibility"
  >
    <template #trigger="{ toggle, open }">
      <button
        class="board-add"
        type="button"
        :class="{ on: open }"
        :title="t('project.newColumn')"
        @click="toggle"
      >
        <EditorIcon name="o.plus" />
      </button>
    </template>
  </DropdownMenu>
      </div>
   </div>
    </div>

    <!-- ① Create new issue（模态，复用 IssueCreateDialog） -->
    <IssueCreateDialog
      :open="createOpen"
      :repo-options="repoMenu"
      :initial-repo-id="repoMenu[0]?.value"
      :project-label="store.selected?.displayName ?? ''"
      @created="onIssueCreated"
      @close="createOpen = false"
    />
    <!-- ② Add items to project（右侧抽屉） -->
    <ProjectAddItemsDrawer
      :open="drawerOpen"
      :repos="repoMenu"
      :default-repo-id="repoMenu[0]?.value"
      :target-column-id="addColumn"
      :target-lane-id="addLane"
      @close="drawerOpen = false"
    />

    <!-- 编辑详情：GitHub 形态的 Edit option 对话框 -->
    <OptionEditDialog
      :open="!!editTarget"
      :mode="editMode"
      :name="editTarget ? (findOption(editTarget.fieldId, editTarget.target.optionId)?.name ?? editTarget.target.name) : ''"
      :color="editTarget ? (findOption(editTarget.fieldId, editTarget.target.optionId)?.color ?? '') : ''"
      :description="editTarget ? findOption(editTarget.fieldId, editTarget.target.optionId)?.description ?? '' : ''"
      @save="submitEdit"
      @cancel="editTarget = null"
    />
    <div v-if="limitTarget" class="bd-modal" @click.self="limitTarget = null">
      <div class="bd-card">
        <p class="bd-title">{{ t("project.actLimit") }}</p>
        <input v-model="limitValue" class="bd-input" type="number" min="0" :placeholder="t('project.actLimitHint')" />
        <div class="bd-actions">
          <button class="bd-btn" @click="limitTarget = null">{{ t("conn.cancel") }}</button>
          <button class="bd-btn primary" @click="submitLimit">{{ t("common.save") }}</button>
        </div>
      </div>
    </div>

    

  </div>

    <!-- GitHub 的底部 omnibar（共享组件 ProjectOmnibar）：点新增才出现，外点 / Esc 隐藏 -->
    <ProjectOmnibar
      ref="omni"
      @create-draft="onOmnibarDraft"
      @open-create-dialog="openCreateDialog"
      @add-from-repo="openAddItemsDrawer"
      @create-issue="onOmnibarIssue"
      @open-change="omniOpen = $event"
    />
  </div>
</template>

<style scoped>
.board-wrap {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  position: relative;
  /* 与过滤栏的间距放在滚动容器外：滚动区内列头顶格开始，
     否则这段 padding 会在吸顶列头上方露出一条“残影缝” */
  padding-top: 10px;
}
/* 「新增列」菜单：列流的最后一个元素（紧跟最后一列右侧，随行滚动） */
.board-add-dd.board-add-dd {
  flex: none;
  align-self: flex-start;
}
.board-add {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel);
  color: var(--text-dim);
  cursor: pointer;
}
.board-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.board {
  /* 整板滚动（平台形态）：列与泳道段按内容自然长高，垂直/横向滚动都发生在
     这一层；列头行与泳道组头吸顶，omnibar 在滚动区之外常驻底边。
     垂直 gap 为 0：列头单元格 → 泳道条 → 列体 上下零间隙拼成连续头部（平台形态）。
     顶部不留 padding：吸顶列头必须顶格，上方不能有能露出滚动内容的缝隙 */
  display: flex;
  flex-direction: column;
  gap: 0;
  flex: 1;
  min-height: 0;
  padding: 0 10px 10px;
  overflow: auto;
  position: relative;
}
/* 分泳道时的列头行（平台：单独一行、最右为「Add a new column」）。
   sticky 需以滚动容器内容为参照：flex 子项的参照是整个内容高度（此前 grid
   布局下 sticky 被困在自身网格区域里，滚动时实际不吸顶）。
   width 取 max-content：背景条要盖住全部列宽，横向滚动时不露底。 */
/* 全板宽度权威：列头行与所有泳道的共同父级。width 取 max-content
   （最宽内容行），min-width 保证列少时铺满视口；子级行一律 width:100%
   跟它对齐——泳道之间、泳道与列头之间的宽度差从构造上不可能出现
   （此前各行独立 max-content，折叠泳道会比展开泳道短一截，实测翻车） */
.board-flow {
  width: max-content;
  min-width: 100%;
}
.board-heads {
  position: sticky;
  top: 0;
  z-index: 6;
  flex: none;
  width: 100%;
  display: flex;
  gap: 8px;
  background: var(--bg-panel);
}
.head-cell {
  /* 平台列头 = 与泳道条一体的描边单元格：只圆上角、不封底，
     侧边框向下穿过泳道条区域，由横条的下边框统一收口 */
  box-sizing: border-box;
  flex: none;
  width: 280px;
  padding: 6px 8px 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
}
/* 泳道段的折叠按钮（平台的 Collapse group） */
.lane-collapse {
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  color: var(--text-dim);
  padding: 2px;
  border-radius: 5px;
  cursor: pointer;
}
.lane-collapse:hover {
  color: var(--text);
  background: var(--bg-hover);
}
/* 泳道模式下的单元格：无列头（列头在单独一行）；段高 = 条目最多列的
   「卡片 + 添加条目」自然高度（平台形态），不给人工底高。
   平台列体通栏灰底，左右边框各一条（与列头单元格侧框、泳道条列界线
   对齐延续，边界处成对双线），上下边框由泳道条的两条横线承担 */
.col.cell-plain {
  padding-top: 8px;
  min-height: 0;
  box-sizing: border-box;
  background: transparent;
  border-top: none;
  border-bottom: none;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  border-radius: 0;
}
/* 末段列体补下边框收口（中间段的列底由下一段泳道条的上边框收口，不重复画）；
   圆角只圆整段最外的两角（与列头单元格顶角、泳道条圆角同族），内部分隔保持直角 */
.lane:last-of-type .col.cell-plain {
  border-bottom: 1px solid var(--border);
}
.lane:last-of-type .col.cell-plain:first-child {
  border-bottom-left-radius: 8px;
}
.lane:last-of-type .col.cell-plain:last-child {
  border-bottom-right-radius: 8px;
}
/* 段：段头 + 一行列。分泳道时高度 = 内容（平台形态，整板滚动的前提）；
   不分泳道（Backlog）单段撑满面板。width 取 max-content 让段头横条
   贯通全部列宽（平台形态），min-width 保证列少时仍铺满视口。
   flex-shrink:0 必须：列 flex 容器高度不足时会把子项压扁而不是溢出，
   不禁收缩的话整板滚动永远不触发、卡片会溢出段边界 */
.lane {
  display: flex;
  flex-direction: column;
  gap: 0; /* 泳道条与列体贴合（平台：连续头部，靠横条下边框分隔） */
  min-height: 0;
  width: 100%; /* 跟随 board-flow（宽度权威），与列头行严格等宽 */
  flex-shrink: 0;
}
.lane-fill {
  flex: 1 1 auto;
}
/* 泳道组头 = 列头下方的白色实底横条（平台形态：不透明白底、上下各一条
   横线收口，不做任何列界线的模拟），滚动时钉在列头行正下方 */
.lane-head {
  position: sticky;
  top: var(--heads-h, 0px);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  min-height: 40px;
  margin: 0;
  padding: 4px 10px;
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
}
.lane-cols {
  display: flex;
  gap: 8px;
  align-items: stretch;
  flex: 1 1 auto;
  min-height: 0;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 列固定宽度（平台行为）：不够宽时横向滚动，不拉伸 */
  flex: none;
  width: 280px;
  min-height: 220px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
}
/* 列体：分泳道时随整板滚动（平台的泳道带等高、随板长高）；
   Backlog（不分泳道）保留列内滚动（既有桌面适配）。
   basis 必须 auto：段高=内容后，basis 0 会把段体高度坍缩成 0（卡片溢出段边界） */
.col-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 auto;
  min-height: 0;
}
.col-body.col-scroll {
  overflow-y: auto;
}
/* Backlog（无泳道）：列排末尾的小 ＋（平台为列头行右端的小按钮，非占位列） */
.col-head-add {
  align-self: flex-start;
  flex: none;
  margin-top: 2px;
}
.col-head {
  display: flex;
  align-items: center;
  gap: 8px; /* 平台：Heading gap 8px */
  margin: 0;
  min-height: 28px;
  color: var(--text);
}
/* 列名 = 体系内「组头名称」档（--font-base/600，AGENTS.md 层级示例）。
   平台此处是 24px 大标题，桌面不引入体系外尺寸，列宽也更窄。
   可收缩 + 省略号：列头内容（名+计数+汇总+⋯+＋）超出 280 列宽时截断名称，
   ＋/⋯ 必须留在卡片内（In progress 长名曾把 ＋ 顶出右缘，实测翻车） */
.col-name {
  margin: 0;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: var(--font-base);
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.col-count,
.col-sum {
  flex: none;
}
.col-spacer {
  flex: 1;
}
.col-btn {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  cursor: pointer;
  padding: 0 3px;
  border-radius: 4px;
}
/* 编辑详情 / 设置上限的弹层 */
.bd-modal {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.35);
}
.bd-card {
  width: 280px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
}
.bd-title {
  margin: 0;
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.bd-input {
  box-sizing: border-box;
  width: 100%;
  font-size: var(--font-md);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 5px 8px;
  outline: none;
}
.bd-input:focus {
  border-color: var(--accent);
}
.bd-color-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--font-md);
  color: var(--text-dim);
}
.bd-color {
  width: 36px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
}
.bd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.bd-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  height: 24px;
  padding: 0 10px;
  border-radius: 5px;
  cursor: pointer;
}
.bd-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.bd-btn.primary {
  border-color: var(--accent);
  color: var(--accent);
}
.col-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.col-btn.plus {
  font-size: var(--font-base);
}
/* 列头色环（平台实测 16px 圆、2px 描边、语义 muted 底） */
.col-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid currentColor;
  flex: none;
}
/* 计数（平台 CounterLabel：18px 胶囊、12px/600、中性底） */
.col-count {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 2px 6px;
  border-radius: 20px;
  background: #818b981f;
  color: var(--text);
  font-size: var(--font-md);
  font-weight: 600;
  line-height: 12px;
}
/* 列说明（选项的 Description） */
.col-desc {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 求和 pill（平台 Label small：20px、12px/500、次级色 + 描边胶囊，文本 `字段名: 值`） */
.col-sum {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 9999px;
  color: var(--text-dim);
  font-size: var(--font-md);
  font-weight: 500;
  line-height: 12px;
  white-space: nowrap;
}
.card {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  /* 卡片内边距：左右 12（平台），上下 8（用户口径：标签区上下最多 8px） */
  padding: 8px 12px 8px;
  cursor: grab;
}
.card:active {
  cursor: grabbing;
}
.card.ghosty {
  opacity: 0.55;
  border-style: dashed;
}
.card.dropping {
  border-color: var(--accent);
}
.card.clickable:hover {
  border-color: var(--accent);
}
.card-title-input {
  width: 100%;
  box-sizing: border-box;
  font-size: var(--font-md);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 2px 5px;
  outline: none;
}
.card-title {
  margin: 0 0 4px;
  font-size: var(--font-lg); /* 平台卡片标题实测 14px（用户取证图 2026-09-16） */
  font-weight: 400; /* 平台正文字重（非加粗） */
  line-height: 18.2px;
  color: var(--text);
  word-break: break-word;
}
/* 元信息行（平台实测）：状态图标 16 + `仓库 #编号` 次级 12px + 头像 20；⋯ 悬停显形 */
.card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-size: var(--font-md);
  color: var(--text-dim);
}
.card-state {
  flex: none;
}
.card-ref {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-spacer {
  flex: 1;
  min-width: 0;
}
.card-avatar {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}
.card-menu {
  flex: none;
}
/* 字段 chip 行（平台实测：flex、gap 4、margin-top 8；chip = 20px 胶囊、padding 1/6、
   12px/600、语义三色由内联样式给（见 field-chip.ts）） */
.card-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 8px 0 0;
}
.card-pill {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  height: 20px;
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border: 1px solid transparent;
  border-radius: 9999px;
  font-size: var(--font-md);
  font-weight: 600;
}
.card-convert {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 5px;
}
.card-link {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: var(--font-sm);
  cursor: pointer;
  padding: 0;
}
.card-dd {
  max-width: 140px;
}
/* 目标格的插入指示条（平台的蓝色横条） */
.omni-target-bar {
  display: block;
  height: 4px;
  border-radius: 2px;
  background: var(--accent);
  margin: 2px 0 6px;
}
/* 格子底部的 Add item：整宽按钮 [＋ 图标] + 文案（照 GitHub）；
   默认隐藏、鼠标扫过列时显示（平台行为），键盘聚焦与「当前目标格」同样显示。 */
.cell-add {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-top: 2px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-base);
  font-family: inherit;
  /* 平台形态：＋ 与文案整体在列内居中 */
  justify-content: center;
  text-align: center;
  padding: 0 12px;
  height: 32px;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.col:hover .cell-add,
.col:focus-within .cell-add,
.cell-add:focus-visible,
.cell-add.target {
  opacity: 1;
}
.cell-add:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.drop-hint {
  margin: 0;
  text-align: center;
  color: var(--accent);
  font-size: var(--font-md);
}
</style>
