<script setup lang="ts">
/**
 * Table view — the same projected data as the Board, rendered as rows
 * (design: "Board / Table are two projections of the same cached data,
 * no extra storage").
 * 对齐平台 table 布局（2026-09 取证 views/1?layout=table，像素扫描 + 交互取证）：
 * 行号列（hover 换 ▾ 行菜单）、列头 ⋯ 右对齐列尾、列间浅竖线、排序=表头
 * 深色下划线、Title=状态图标+标题+灰色 #编号、单选字段=pill+▾ 就地改值、
 * 列头菜单=选择列/排序/按值筛选/移动/隐藏、表尾「新建字段」、底部 add 行、
 * 行高 38px、数字列右对齐。
 */
import { computed, nextTick, ref } from "vue";
import { storeToRefs } from "pinia";
import { useProjectsStore } from "../../stores/projects";
import { api, type ProjectField, type ProjectItem } from "../../api";
import { useI18n } from "../../i18n";
import DropdownMenu from "../../components/DropdownMenu.vue";
import ActionMenu, { type ActionItem } from "../../components/ActionMenu.vue";
import EditorIcon from "../../components/EditorIcon.vue";
import ProjectOmnibar from "../ProjectOmnibar.vue";
import IssueCreateDialog from "../IssueCreateDialog.vue";
import ProjectAddItemsDrawer from "../ProjectAddItemsDrawer.vue";
import MetaPicker from "../../components/MetaPicker.vue";
import { pushToast } from "../../toast";
import { translateError } from "../../gh-errors";
import { chipColors } from "../field-chip";
import { itemTitle } from "../item-fields";

const store = useProjectsStore();
const { selectedId, filteredItems } = storeToRefs(store);
const { t } = useI18n();

const rows = computed(() => filteredItems.value);

/** 泳道维度（视图「泳道」字段，如优先级）：存在时表格按其分组（平台
 * Priority board 切 Table 布局 = 按优先级分组的表格，分组字段不再重复为列）。 */
const swim = computed(() => store.swimlaneField);
const swimKey = computed(() => {
  const f = swim.value;
  if (!f) return "";
  if (f.kind === "builtin_status") return "status";
  return f.name === "优先级" ? "priority" : f.id;
});

/** 列 = 视图「字段」开关打开的那些；顺序跟随 view.fields（平台的列移动
 * 就是对这个数组重排序。注意：字段显隐开关会把顺序归一回目录序）。
 * 泳道维度激活时，分组字段本身不重复为列（平台同款：泳道字段不上列）。 */
const columns = computed(() =>
  (store.view.fields as string[])
    .filter((id) => store.fieldCatalogue.some((f) => f.id === id))
    .filter((id) => id !== swimKey.value),
);

/** 分组渲染模型：泳道维度激活 = 每个选项一组（无值段置底，平台 No Priority）；
 * 未激活 = 单一扁平组（无组头）。start = 组内行号的全局偏移（跨组连续编号）。 */
const renderGroups = computed(() => {
  const f = swim.value;
  if (!f) {
    return [
      { id: "__flat__", name: null as string | null, color: null as string | null, description: null as string | null, items: filteredItems.value, start: 0 },
    ];
  }
  let n = 0;
  return store
    .swimlaneOptions()
    .filter((o) => !store.isHidden("lane", o.id))
    .map((o) => {
      const items = filteredItems.value.filter((i) => (i.fieldValues[f.id] ?? "") === o.id);
      const g = {
        id: o.id,
        name: o.id === "" ? t("project.columnNoValue", { field: f.name }) : o.name,
        color: o.color || null,
        description: o.description || null,
        items,
        start: n,
      };
      n += items.length;
      return g;
    })
    // 切片激活时空分组不渲染（平台 Team items：选 Done 只显示 Done 组；
    // 空组无条目不影响行号连续性）
    .filter((g) => store.view.sliceFieldId === null || g.items.length > 0);
});
/** 组头 ⋯：从视图中隐藏该组（泳道维度隐藏走 hiddenLanes，与看板同机制）。 */
function groupMenuItems(): ActionItem[] {
  return [
    { value: "hide", label: t("project.actHide"), icon: "o.hide" },
  ];
}
function onGroupPick(groupId: string) {
  store.toggleHidden("lane", groupId);
}
function headerOf(id: string): string {
  return store.fieldName(id);
}

/** 单元格：统一走 store.cellOf（固定字段走本地/镜像，项目字段走字段值）；
 * 空值渲染为空白（平台形态，不是「—」占位）。 */
function cellText(id: string, item: ProjectItem): string {
  return store.cellOf(id, item)?.text ?? "";
}

// ---- 列头 ⋯ 菜单（平台形态：所有列都有菜单；条目带 octicon 图标；
// 移动项在边缘显示禁用 + 灰色提示副行）----
function isSorted(id: string): boolean {
  const fs = store.view.fieldSort;
  return !!fs && (fs.fieldId === id || fieldOf(id)?.id === fs.fieldId);
}
/** 排序图标方向：升序 ≡↑（octicon sort-asc），降序 ≡↓（octicon sort-desc）。 */
function sortIcon(): string {
  const fs = store.view.fieldSort;
  return fs?.desc ? "o.sort-desc" : "o.sort-asc";
}
function columnMenuItems(id: string): ActionItem[] {
  const field = fieldOf(id);
  const fieldsArr = store.view.fields as string[];
  const idx = fieldsArr.indexOf(id);
  const last = fieldsArr.length - 1;
  const out: ActionItem[] = [
    {
      value: "select",
      label: t("project.actSelectColumn"),
      icon: "o.checklist",
      submenu: store.fieldCatalogue.map((f) => ({
        value: `vis:${f.id}`,
        label: f.name,
        icon: store.view.fields.includes(f.id as never) ? "o.check" : undefined,
      })),
    },
    // 平台用分隔线分段（无组标题文字）：升/降序一组，筛选一组，移动一组
    { value: "asc", label: t("project.actSortAsc"), icon: "o.sort-asc", dividerBefore: true },
    { value: "desc", label: t("project.actSortDesc"), icon: "o.sort-desc" },
  ];
  // 按值筛选：单选字段用选项表；固定字段用当列实际出现过的显示值（平台任意列可筛选）
  const values = field?.options.length
    ? field.options.map((o) => o.name || t("project.columnNoValue", { field: field.name }))
    : [...new Set(rows.value.map((i) => cellText(id, i)).filter(Boolean))];
  if (values.length) {
    out.push({
      value: "filter",
      label: t("project.actFilterValues"),
      icon: "o.filter",
      dividerBefore: true,
      submenu: values.map((v) => ({ value: `filter:${v}`, label: v })),
    });
  }
  // 按类型或状态筛选（平台所有列都有）：写入 `类型:x` / `开闭状态:x` token
  out.push({
    value: "filterts",
    label: t("project.actFilterTypeState"),
    icon: "o.filter",
    submenu: [
      { value: `tfilter:${t("project.colKind")}:${t("project.kindIssue")}`, label: t("project.kindIssue") },
      { value: `tfilter:${t("project.colKind")}:${t("project.kindPull")}`, label: t("project.kindPull") },
      { value: `tfilter:${t("project.colKind")}:${t("project.draftTag")}`, label: t("project.draftTag") },
      { value: `tfilter:${t("project.colState")}:${t("state.open")}`, label: t("state.open") },
      { value: `tfilter:${t("project.colState")}:${t("state.closed")}`, label: t("state.closed") },
    ],
  });
  // 移动：平台在边缘显示禁用项 + 灰色提示副行（不可点）
  out.push(
    { value: "move:left", label: t("project.actMoveLeft"), icon: "o.arrow-left", dividerBefore: true, disabled: idx <= 0, hint: idx <= 0 ? t("project.actLeftMostHint") : undefined },
    { value: "move:right", label: t("project.actMoveRight"), icon: "o.arrow-right", disabled: idx >= last, hint: idx >= last ? t("project.actRightMostHint") : undefined },
    { value: "move:start", label: t("project.actMoveStart"), icon: "o.arrow-left", disabled: idx <= 0, hint: idx <= 0 ? t("project.actLeftMostHint") : undefined },
    { value: "move:end", label: t("project.actMoveEnd"), icon: "o.arrow-right", disabled: idx >= last, hint: idx >= last ? t("project.actRightMostHint") : undefined },
  );
  out.push({ value: "hide", label: t("project.actHide"), icon: "o.hide", dividerBefore: true });
  return out;
}
/** 列移动 = 对 view.fields 重排序（列顺序即该数组顺序）。 */
function moveColumn(id: string, to: "left" | "right" | "start" | "end") {
  const arr = [...(store.view.fields as string[])];
  const i = arr.indexOf(id);
  if (i < 0) return;
  arr.splice(i, 1);
  if (to === "left") arr.splice(Math.max(0, i - 1), 0, id);
  else if (to === "right") arr.splice(Math.min(arr.length, i), 0, id);
  else if (to === "start") arr.unshift(id);
  else arr.push(id);
  store.view.fields = arr as never;
}
/** 按值筛选：写入 `列名:值` token（列名 = 表头显示名，store 按别名解析）。 */
function appendColumnFilter(col: string, val: string) {
  const token = `${headerOf(col)}:${val}`;
  const cur = store.view.filter.trim();
  store.view.filter = cur ? `${cur} ${token}` : token;
}
async function onColumnPick(id: string, value: string) {
  if (value.startsWith("vis:")) {
    store.toggleField(value.slice(4) as never);
    return;
  }
  if (value.startsWith("filter:")) {
    appendColumnFilter(id, value.slice(7));
    return;
  }
  if (value.startsWith("tfilter:")) {
    const token = value.slice(8);
    const cur = store.view.filter.trim();
    store.view.filter = cur ? `${cur} ${token}` : token;
    return;
  }
  if (value.startsWith("move:")) {
    moveColumn(id, value.slice(5) as "left" | "right" | "start" | "end");
    return;
  }
  if (value === "hide") {
    store.toggleField(id as never);
    return;
  }
  // 排序：项目字段按 fieldId，固定字段直接用视图键（store 按显示文本排序）
  if (value === "asc") store.setFieldSort(fieldOf(id)?.id ?? id, false);
  else if (value === "desc") store.setFieldSort(fieldOf(id)?.id ?? id, true);
  else if (value === "clear") store.setFieldSort(null);
}

// ---- 表尾 +（平台的 Add field 面板）：勾选字段即增删列；底部动作 = 新建字段 ----
const addingColumn = ref(false);
const newColName = ref("");
const newColKind = ref<"single_select" | "text" | "number" | "date">("single_select");
const newColOptions = ref("");
const kindChoices = computed(() => [
  { value: "single_select", label: t("project.fieldTypeSingle") },
  { value: "text", label: t("project.fieldTypeText") },
  { value: "number", label: t("project.fieldTypeNumber") },
  { value: "date", label: t("project.fieldTypeDate") },
]);
/** 字段在勾选面板里的图标（平台每字段一枚；octicon 同源抓取）。 */
function fieldIcon(id: string): string | undefined {
  if (id === "title") return "o.md-list-unordered";
  if (id === "kind" || id === "state") return "o.issue-opened";
  if (id === "source" || id === "milestone") return id === "source" ? "o.repo" : "o.milestone";
  if (id === "added" || id === "created") return "o.calendar";
  if (id === "updated") return "o.clock";
  if (id === "author" || id === "assignees") return "o.people";
  if (id === "labels") return "o.tag";
  const kind = fieldOf(id)?.kind;
  if (kind === "number") return "o.number";
  if (kind === "date") return "o.calendar";
  return undefined;
}
const fieldSections = computed(() => {
  const base = store.fieldCatalogue.map((f) => ({ value: f.id, label: f.name, icon: fieldIcon(f.id) }));
  const isProject = (value: string) => store.fieldCatalogue.find((c) => c.id === value)?.section === "project";
  const plain = base.filter((o) => !isProject(o.value));
  const proj = base.filter((o) => isProject(o.value));
  const out: { title?: string; options: typeof base }[] = [];
  if (plain.length) out.push({ options: plain });
  if (proj.length) out.push({ title: t("project.fieldSectionProject"), options: proj });
  return out;
});
function onFieldsChange(next: string[]) {
  // 平台 Title 列锁定必显（参考截图：Title 行勾选置灰不可取消）
  store.view.fields = (next.includes("title") ? next : ["title", ...next]) as never;
}
async function submitNewColumn() {
  const name = newColName.value.trim();
  if (!name) {
    addingColumn.value = false;
    return;
  }
  const options = newColOptions.value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    await store.createField(name, newColKind.value, options);
  } finally {
    newColName.value = "";
    newColOptions.value = "";
    addingColumn.value = false;
  }
}

// ---- 项目字段（含自建）在表格里可就地编辑 ----
function fieldOf(id: string): ProjectField | null {
  return store.fieldByViewKey(id);
}
function optionChoices(id: string) {
  return (fieldOf(id)?.options ?? []).map((o) => ({ value: o.id, label: o.name, color: o.color }));
}
function valueOf(id: string, item: ProjectItem): string {
  const field = fieldOf(id);
  return field ? (item.fieldValues[field.id] ?? "") : "";
}
function optionOf(id: string, item: ProjectItem) {
  const value = valueOf(id, item);
  return fieldOf(id)?.options.find((o) => o.id === value) ?? null;
}
function pillStyle(color: string | null | undefined) {
  const c = chipColors(color);
  return { background: c.bg, color: c.fg };
}
function inputType(id: string): string {
  const kind = fieldOf(id)?.kind;
  return kind === "number" ? "number" : kind === "date" ? "date" : "text";
}

// ---- Title 单元格（平台：状态图标 + 标题 + 灰色 #编号 同排）----
function stateIconOf(item: ProjectItem): string | null {
  if (item.kind === "draft") return null;
  if (item.kind === "pull") return "pull";
  const state = (item.entity?.state ?? "").toUpperCase();
  return state === "CLOSED" ? "o.issue-closed" : "o.issue-opened";
}
function stateColorOf(item: ProjectItem): string {
  const state = (item.entity?.state ?? "").toUpperCase();
  return state === "CLOSED" || state === "MERGED" ? "var(--merged)" : "var(--success)";
}
function refOf(item: ProjectItem): string {
  return item.number ? `#${item.number}` : "";
}

// ---- 负责人单元格（平台：头像 + 名称 + ▾，点选可改；写通道 = issue_update_assignees，
// 仅在线 Issue 开放——PR/草稿/悬挂只读，与抽屉的 canEditMeta 同口径）----
const assigneesEditing = ref<string | null>(null);
const assigneeOptionsCache = ref<Record<string, string[]>>({});
function repoTargetOf(item: ProjectItem): string | null {
  return repoChoices.value.find((r) => r.id === item.repoId)?.target ?? null;
}
function assigneesEditable(item: ProjectItem): boolean {
  return item.kind === "issue" && !item.ghost && !!item.number && !!item.repoId;
}
async function openAssignees(item: ProjectItem) {
  if (!assigneesEditable(item)) return;
  assigneesEditing.value = item.id;
  void ensureRepos();
  const target = repoTargetOf(item);
  if (target && !assigneeOptionsCache.value[target]) {
    try {
      assigneeOptionsCache.value[target] = await api.assigneeList(target);
    } catch {
      assigneeOptionsCache.value[target] = [];
    }
  }
}
function assigneeChoiceOptions(item: ProjectItem) {
  const target = repoTargetOf(item);
  const opts = (target ? assigneeOptionsCache.value[target] : null) ?? [];
  const cur = item.entity?.assignees ?? [];
  const merged = [...cur, ...opts.filter((o) => !cur.includes(o))];
  return merged.map((a) => ({ value: a, label: a, avatar: `https://github.com/${a}.png?size=40` }));
}
async function toggleAssignee(item: ProjectItem, login: string) {
  const target = repoTargetOf(item);
  if (!target || !item.number) return;
  const cur = item.entity?.assignees ?? [];
  const next = cur.includes(login) ? cur.filter((a) => a !== login) : [...cur, login];
  try {
    await api.issueUpdateAssignees(target, item.number, next);
    await store.refreshSelected();
  } catch (e) {
    pushToast({ kind: "error", message: translateError(String(e)) });
  }
}

// ---- 行号 ▾ 菜单（③适配：平台菜单内容未取证，先接与看板卡片同源的条目动作；
// 顺序照平台条目菜单：Move to column → Archive → Remove from project）----
function rowMenuItems(item: ProjectItem): ActionItem[] {
  const status = store.columnField;
  const cur = status ? (item.fieldValues[status.id] ?? "") : "";
  const out: ActionItem[] = [];
  if (status && status.options.length > 1) {
    out.push({
      value: "move",
      label: t("project.actMoveToColumn"),
      icon: "o.arrow-both",
      submenu: status.options
        .filter((o) => o.id !== cur)
        .map((o) => ({ value: `move:${o.id}`, label: o.name })),
    });
  }
  out.push({
    value: "archive",
    label: t("project.actArchive"),
    icon: "o.archive",
    badge: "E",
    dividerBefore: out.length > 0,
  });
  out.push({
    value: "remove",
    label: t("project.actRemoveFromProject"),
    icon: "o.trash",
    danger: true,
    badge: "Del",
    dividerBefore: true,
  });
  return out;
}
async function onRowMenuPick(item: ProjectItem, value: string) {
  if (value.startsWith("move:")) await store.moveItem(item.id, value.slice(5));
  else if (value === "archive") await store.archiveItem(item.id, true);
  else if (value === "remove") await store.removeItem(item.id);
}

/** 草稿卡就地保存（标题 + 正文；平台表格/看板均为就地编辑）。 */
function saveDraft(item: ProjectItem, title: string, body: string) {
  if (!title.trim()) return;
  void store.updateDraft(item.id, title.trim(), body);
}

function commit(id: string, item: ProjectItem, value: string) {
  const field = fieldOf(id);
  if (!field) return;
  void store.setFieldValue(item.id, field.id, value.trim() ? value : undefined);
}

// ---- 底部 add 行（平台的 Add item：共享 omnibar + Create dialog + 抽屉）----
const omni = ref<InstanceType<typeof ProjectOmnibar> | null>(null);
const adding = ref(false);
/** 泳道分组模式下正在添加的组（每组独立 Add item 行）。 */
const addingGroup = ref<string | null>(null);
function setOmni(el: unknown) {
  omni.value = el as InstanceType<typeof ProjectOmnibar> | null;
}
async function startGroupAdd(gid: string) {
  addingGroup.value = gid;
  await nextTick();
  omni.value?.open();
}
/** 组内添加行的点击 = 切换（再点同一行 ＋ 收起）。输入条内部点击不参与——
 *  外点关闭监听已豁免宿主行（data-omni-host），关闭职责归本 handler */
function onGroupAddRowClick(gid: string, event: MouseEvent) {
  if ((event.target as HTMLElement | null)?.closest(".omnibar")) return;
  if (addingGroup.value === gid) {
    addingGroup.value = null;
    return;
  }
  void startGroupAdd(gid);
}
/** 扁平模式表尾添加行：同一切换语义 */
function onFlatAddRowClick(event: MouseEvent) {
  if ((event.target as HTMLElement | null)?.closest(".omnibar")) return;
  if (adding.value) {
    adding.value = false;
    return;
  }
  void openAdd();
}
const createOpen = ref(false);
const drawerOpen = ref(false);
const repoChoices = ref<
  { id: string; label: string; visibility?: string | null; target: string; remoteUrl?: string | null }[]
>([]);
const repoMenu = ref<{ value: string; label: string; target: string; visibility: string | null }[]>([]);
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
/** 仓库候选：项目绑定优先，不足则并入全部登记仓库（与看板 ensureRepoMenu 同款）。 */
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
async function openAdd() {
  adding.value = true;
  await nextTick();
  omni.value?.open();
}
/** omnibar 回车建草稿；泳道维度激活时落入对应分组（写入泳道字段值）。 */
async function submitAdd(title: string, groupId?: string) {
  if (!selectedId.value) return;
  const created = await store.addItem({ projectId: selectedId.value, kind: "draft", draftTitle: title });
  if (created && groupId && swim.value) {
    await store.setFieldValue(created.id, swim.value.id, groupId);
  }
}
function openCreateDialog() {
  omni.value?.close();
  void ensureRepoMenu();
  createOpen.value = true;
}
/** 新建 Issue 成功 → 作为引用条目加入（表格无目标格，字段值随同步补齐）。 */
async function onIssueCreated(payload: { number: string; repoId: string }) {
  if (!selectedId.value) return;
  await store.addItem({
    projectId: selectedId.value,
    kind: "issue",
    repoId: payload.repoId,
    number: payload.number,
  });
}
function openDrawer() {
  omni.value?.close();
  void ensureRepoMenu();
  drawerOpen.value = true;
}
/** omnibar 点选 Issue → 以引用条目加入；泳道维度激活时落入对应分组。 */
async function onOmnibarIssue(payload: { repoId: string; number: string }, groupId?: string) {
  if (!selectedId.value) return;
  const created = await store.addItem({
    projectId: selectedId.value,
    kind: "issue",
    repoId: payload.repoId,
    number: payload.number,
  });
  if (created && groupId && swim.value) {
    await store.setFieldValue(created.id, swim.value.id, groupId);
  }
}

/** 行点击 = 打开 item 抽屉（平台形态）；就地编辑控件上的点击不触发。 */
function onRowClick(item: ProjectItem, event: MouseEvent) {
  const el = event.target as HTMLElement | null;
  if (el?.closest("input, button, select, textarea, .dd")) return;
  store.openPanelItem(item.id);
}
</script>

<template>
  <div class="tbl-wrap">
    <table
      class="tbl"
      :class="{ 'tbl-fullwidth': swim }"
      :style="swim
        ? { width: '100%' }
        : { width: `${60 + 650 + 200 * Math.max(0, columns.length - 1) + 44}px` }"
    >
      <!-- fixed 布局的列宽以 colgroup 为最高优先级（首行单元格声明在
       WebKit 的 width:max-content 表里会被内容反推覆盖，实测 66px 被撑成 200） -->
      <colgroup>
        <!-- 行号/新建列的宽度也走内联：class 版在 col 上会被布局解析吞掉（实测） -->
        <col style="width: 60px" />
        <col
          v-for="col in columns"
          :key="`col-${col}`"
          :style="{ width: col === 'title' ? '650px' : '200px' }"
        />
        <col style="width: 44px" />
      </colgroup>
      <thead>
        <tr>
          <th class="th-num" aria-hidden="true"></th>
          <th
            v-for="col in columns"
            :key="col"
            :class="{ 'th-title': col === 'title', 'th-sorted': isSorted(col) }"
          >
            <span class="th-cell">
              <span class="th-label">{{ headerOf(col) }}</span>
              <span class="th-spacer"></span>
              <!-- 排序列指示：平台在 ⋯ 左侧显示单枚排序图标（升序 ≡↑ / 降序 ≡↓），
                   与下划线一起出现；方向跟随 fieldSort.desc -->
              <span v-if="isSorted(col)" class="th-sorticon">
                <EditorIcon :name="sortIcon()" />
              </span>
              <ActionMenu
                trigger-icon="ellipsis"
                :title="t('project.actColumnMenu')"
                :items="columnMenuItems(col)"
                @pick="onColumnPick(col, $event)"
              />
            </span>
          </th>
          <!-- 表尾 +：平台的 Add field 面板（勾选字段即增删列；底部动作 = 新建字段） -->
          <th class="th-addcol">
            <DropdownMenu
              class="addfield-dd"
              multiple
              checkbox
              checkbox-start
              :menu-width="400"
              :panel-title="{ icon: 'o.plus', label: t('project.addFieldTitle') }"
              :action="{ value: 'newfield', label: t('project.fieldAdd'), icon: 'o.plus' }"
              action-bottom
              :sections="fieldSections"
              :model-value="(store.view.fields as string[])"
              @update:model-value="onFieldsChange($event as string[])"
              @action="addingColumn = true"
            >
              <template #trigger="{ toggle, open }">
                <button
                  type="button"
                  class="col-add"
                  :class="{ on: open }"
                  :title="t('project.addFieldTitle')"
                  @click="toggle"
                >
                  <EditorIcon name="o.plus" />
                </button>
              </template>
            </DropdownMenu>
            <!-- 新建字段（平台面板底部 New field）：锚定小面板承载名称/类型/选项 -->
            <div v-if="addingColumn" class="col-add-form">
              <input
                v-model="newColName"
                class="cell-input"
                :placeholder="t('project.fieldNamePlaceholder')"
                @keydown.esc="addingColumn = false"
              />
              <DropdownMenu
                class="kind-dd"
                :options="kindChoices"
                :model-value="newColKind"
                @update:model-value="newColKind = $event as typeof newColKind"
              />
              <input
                v-if="newColKind === 'single_select'"
                v-model="newColOptions"
                class="cell-input"
                :placeholder="t('project.fieldOptionsHint')"
                @keydown.esc="addingColumn = false"
              />
              <button type="button" class="col-add-ok" :title="t('project.fieldAdd')" @click="submitNewColumn">
                <EditorIcon name="o.check" />
              </button>
            </div>
          </th>
        </tr>
      </thead>
      <tbody>
        <template v-for="g in renderGroups" :key="g.id">
          <!-- 组头（平台 Group by 行）：折叠 ⌄ + 色点 + 名称 + 计数 + 汇总 + ⋯；
               白底横贯全宽、无列竖线。折叠时组头是本组最后一个可见行，
               12px 组间隙挂它的 border-bottom（见样式 .tbl-grouprow--collapsed） -->
          <tr
            v-if="g.name !== null"
            class="tbl-grouprow"
            :class="{ 'tbl-grouprow--collapsed': store.isLaneCollapsed(g.id) }"
          >
            <td :colspan="columns.length + 2">
              <span class="grp-head">
                <button
                  type="button"
                  class="grp-collapse"
                  :title="store.isLaneCollapsed(g.id) ? t('project.expandLane') : t('project.collapseLane')"
                  @click="store.toggleLaneCollapsed(g.id)"
                >
                  <EditorIcon :name="store.isLaneCollapsed(g.id) ? 'chevron' : 'o.chevron-down'" />
                </button>
                <span v-if="g.color" class="grp-dot" :style="{ background: g.color }"></span>
                <span class="grp-name">{{ g.name }}</span>
                <span class="grp-count">{{ g.items.length }}</span>
                <span v-for="s in store.laneSums(g.id)" :key="s.label" class="grp-sum">
                  {{ s.label }}: {{ s.value }}
                </span>
                <!-- 组头描述（平台：选项说明随组头展示，如 "This is actively being worked on"） -->
                <span v-if="g.description" class="grp-desc">{{ g.description }}</span>
                <span class="th-spacer"></span>
                <ActionMenu
                  trigger-icon="ellipsis"
                  :title="t('project.actLaneMenu')"
                  :items="groupMenuItems()"
                  @pick="onGroupPick(g.id)"
                />
              </span>
            </td>
          </tr>
          <template v-if="!store.isLaneCollapsed(g.id)">
            <tr
              v-for="(item, j) in g.items"
              :key="item.id"
              :class="{ ghosty: item.ghost }"
              @click="onRowClick(item, $event)"
            >
              <td class="td-num">
                <span class="num-wrap">
                  <span class="num">{{ g.start + j + 1 }}</span>
                  <ActionMenu
                    class="row-menu"
                    trigger-icon="ellipsis"
                    :title="t('project.actItemMenu')"
                    :items="rowMenuItems(item)"
                    @pick="onRowMenuPick(item, $event)"
                  />
                </span>
              </td>
          <td
            v-for="col in columns"
            :key="col"
            :class="{
              'td-title': col === 'title',
              'td-src': col === 'source',
              'td-numfield': fieldOf(col)?.kind === 'number',
            }"
          >
            <!-- Title：草稿就地编辑；引用条目 = 状态图标 + 标题 + 灰色 #编号 -->
            <template v-if="col === 'title'">
              <input
                v-if="item.kind === 'draft'"
                class="cell-input"
                :value="item.draftTitle ?? ''"
                @change="saveDraft(item, ($event.target as HTMLInputElement).value, item.draftBody ?? '')"
              />
              <span v-else class="title-cell">
                <EditorIcon
                  v-if="stateIconOf(item)"
                  class="row-state"
                  :name="stateIconOf(item)!"
                  :style="{ color: stateColorOf(item) }"
                />
                <span class="title-text">{{ itemTitle(item) }}</span>
                <span v-if="refOf(item)" class="td-ref">{{ refOf(item) }}</span>
              </span>
            </template>
            <!-- 单选/状态字段：彩色 pill + ▾，就地改值（平台 pill 形态） -->
            <DropdownMenu
              v-else-if="fieldOf(col) && (fieldOf(col)?.kind === 'single_select' || fieldOf(col)?.kind === 'builtin_status')"
              class="cell-dd"
              :options="optionChoices(col)"
              :model-value="valueOf(col, item)"
              @update:model-value="commit(col, item, $event as string)"
            >
              <template #trigger="{ toggle }">
                <button type="button" class="pill-trigger" @click="toggle">
                  <span v-if="optionOf(col, item)" class="cell-pill" :style="pillStyle(optionOf(col, item)!.color)">
                    {{ optionOf(col, item)!.name }}
                  </span>
                  <EditorIcon class="pill-caret" name="o.chevron-down" />
                </button>
              </template>
            </DropdownMenu>
            <input
              v-else-if="fieldOf(col)"
              class="cell-input"
              :type="inputType(col)"
              :value="valueOf(col, item)"
              @change="commit(col, item, ($event.target as HTMLInputElement).value)"
            />
            <!-- 负责人：头像 + 名称 + ▾（平台可就地改负责人；仅在线 Issue 可写） -->
            <template v-else-if="col === 'assignees'">
              <div class="assignee-cell">
                <button
                  v-if="item.entity?.assignees?.length || assigneesEditable(item)"
                  type="button"
                  class="assignee-trigger"
                  @click.stop="openAssignees(item)"
                >
                  <img
                    v-for="a in item.entity?.assignees ?? []"
                    :key="a"
                    class="assignee-avatar"
                    :src="`https://github.com/${a}.png?size=40`"
                    :alt="a"
                  />
                  <span v-if="item.entity?.assignees?.length" class="assignee-name">
                    {{ item.entity.assignees.join(", ") }}
                  </span>
                  <EditorIcon v-if="assigneesEditable(item)" class="pill-caret" name="o.chevron-down" />
                </button>
                <MetaPicker
                  v-if="assigneesEditing === item.id"
                  open
                  multiple
                  :options="assigneeChoiceOptions(item)"
                  :selected="item.entity?.assignees ?? []"
                  :placeholder="t('project.filterAssignees')"
                  @toggle="toggleAssignee(item, $event)"
                  @close="assigneesEditing = null"
                />
              </div>
            </template>
            <span v-else-if="cellText(col, item)" class="cell-text">{{ cellText(col, item) }}</span>
          </td>
          </tr>
          <!-- 组内 Add item 行（平台：每组独立添加，落入该组；仅泳道分组模式，
               扁平模式的添加行走 tfoot）。组间隙不挂在这行上——折叠组不渲染
               添加行，间隙会随折叠消失（P1→P2 无间隙十轮未解的根因），
               载体改为组头行的 border-top，见 .tbl-grouprow--gap -->
          <tr
            v-if="swim"
            class="add-row"
            :data-omni-host="addingGroup === g.id ? '' : undefined"
            @click="onGroupAddRowClick(g.id, $event)"
          >
            <!-- 单格全宽（含行号列）：＋/输入框两种状态都从行最左开始，
                 ＋ 与文本紧邻——分格会让文本缩进到标题列、＋ 与文本间距过大（实测翻车） -->
            <td :colspan="columns.length + 2" class="add-cell">
              <button v-if="addingGroup !== g.id" type="button" class="add-trigger">
                <EditorIcon name="o.plus" />
                <span>{{ t("project.addItemRow") }}</span>
              </button>
              <ProjectOmnibar
                v-else
                :ref="setOmni"
                inline
                @create-draft="(t) => submitAdd(t, g.id)"
                @open-create-dialog="openCreateDialog"
                @add-from-repo="openDrawer"
                @create-issue="(p) => onOmnibarIssue(p, g.id)"
                @close="addingGroup = null"
              />
            </td>
          </tr>
          </template>
        </template>
      </tbody>
      <!-- 全宽 add 行仅扁平模式（泳道维度激活时改为每组独立添加） -->
      <tfoot v-if="!swim">
        <!-- 底部 add 行（平台：+ 在行首、提示文案随行；点击展开 omnibar 输入条） -->
        <tr
          class="add-row"
          :data-omni-host="adding ? '' : undefined"
          @click="onFlatAddRowClick($event)"
        >
          <!-- 单格全宽（含行号列 + 表尾新建列）：同组内添加行，＋/输入框都顶行首 -->
          <td :colspan="columns.length + 2" class="add-cell">
            <button v-if="!adding" type="button" class="add-trigger" @click.stop="openAdd">
              <EditorIcon name="o.plus" />
              <span>{{ t("project.addItemRow") }}</span>
            </button>
            <ProjectOmnibar
              v-else
              ref="omni"
              inline
              @create-draft="submitAdd"
              @open-create-dialog="openCreateDialog"
              @add-from-repo="openDrawer"
              @create-issue="onOmnibarIssue"
              @close="adding = false"
            />
          </td>
        </tr>
      </tfoot>
    </table>
    <!-- omnibar 两条完整路径的容器：新建 Issue 对话框 / 从仓库添加抽屉 -->
    <IssueCreateDialog
      :open="createOpen"
      :repo-options="repoMenu"
      :initial-repo-id="repoMenu[0]?.value"
      :project-label="store.selected?.displayName ?? ''"
      @created="onIssueCreated"
      @close="createOpen = false"
    />
    <ProjectAddItemsDrawer
      :open="drawerOpen"
      :repos="repoMenu"
      :default-repo-id="repoMenu[0]?.value"
      @close="drawerOpen = false"
    />
    <p v-if="rows.length === 0" class="tbl-empty">{{ t("project.noItems") }}</p>
  </div>
</template>

<style scoped>
.tbl-wrap {
  flex: 1;
  overflow: auto;
  /* 顶部不留间距（用户定案）：过滤框下边框与表头顶线贴合，两线间无空隙 */
  padding: 0 10px 10px;
}
.tbl {
  table-layout: fixed;
  border-collapse: collapse;
  font-size: var(--font-lg);
}
/* 泳道分组模式（平台 Priority board 的 Table 形态）：表格撑满视口宽，
   富余宽度自然摊入 Title 列（平台同款——分组表格没有右侧留白） */
.tbl-fullwidth {
  min-width: 100%;
}
/* 列头：平台实测灰字 12px 常规字重、**高 32px**（数据行 38，表头更瘦）、
   上下各有 1px 线界定表头带；⋯ 菜单右对齐列尾。
   顶线是必须的：没有它，滚动容器上方那段 padding 在视觉上会被读进表头带，
   文字看起来就像"上半部多出一块空白"（实测：带顶线后文字在 32px 带内居中）。 */
th {
  text-align: left;
  color: var(--text-dim);
  font-size: var(--font-md);
  font-weight: 400;
  height: 32px;
  vertical-align: middle;
  padding: 0 8px;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
/* 排序列指示 = 该列表头深色下划线（平台形态，↑↓ 在 ⋯ 菜单里）。
   用 2px 底边框而非 box-shadow：border-collapse 下 WebKit 不渲染单元格阴影 */
.th-sorted {
  border-bottom: 2px solid var(--text);
}
.th-cell {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
}
.th-spacer {
  flex: 1;
}
/* 排序列头的 ↑↓ 双箭头（平台在 ⋯ 左侧，随下划线一起出现） */
.th-sorticon {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  color: var(--text);
}
/* 列间浅竖线：只有数据列之间有（行号|Title 之间与最外圈无线，平台实测） */
.tbl th:nth-child(n + 3),
.tbl td:nth-child(n + 3) {
  border-left: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
}
/* 其余列固定 200px（平台实测） */
th:not(.th-title):not(.th-num):not(.th-addcol),
td:not(.td-title):not(.td-num) {
  width: 200px;
  min-width: 200px;
}
.th-title,
.td-title {
  width: 650px;
  min-width: 650px; /* 平台实测 Title 列 650px */
}
/* 表尾 +（平台的 Add field 面板）：勾选字段即增删列；底部动作 = 新建字段。
   面板宽 400（DropdownMenu menu-width），锚定小面板承载新建表单 */
.th-addcol {
  width: 44px;
  min-width: 44px;
  text-align: center;
  position: relative;
}
.col-add {
  display: inline-flex;
  align-items: center;
  padding: 3px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.col-add:hover,
.col-add.on {
  color: var(--text);
  background: var(--bg-hover);
}
.col-add-form {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 70;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 260px;
  padding: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  text-align: left;
}
.col-add-form .kind-dd {
  align-self: flex-start;
}
.col-add-ok {
  align-self: flex-end;
  display: inline-flex;
  padding: 3px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--success);
  cursor: pointer;
}
.col-add-ok:hover {
  background: var(--bg-hover);
}
/* 行号列：平台实测 60px（= 标题列右缘 710 − 650）、数字右对齐；
   hover 时数字换 ▾ 行菜单（列宽在 colgroup） */
.th-num,
.td-num {
  padding: 0 12px 0 0;
  text-align: right;
}
/* 标题列：平台左内边距 32（状态图标实测落在 92pt） */
.th-title,
.td-title {
  padding-left: 32px;
}
/* 表头文字与内容行文字对齐（平台：缩进图标宽 + 间距） */
.th-title .th-label {
  margin-left: 22px;
}
.td-num {
  text-align: right;
}
.num-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}
.num {
  color: var(--text-dim);
  font-size: var(--font-md);
}
.td-num .row-menu {
  display: none;
}
tbody tr:hover .td-num .num {
  display: none;
}
tbody tr:hover .td-num .row-menu {
  display: inline-flex;
}
/* 单元格：平台实测行高 38px；行分隔为发丝线；数字字段右对齐（平台 Estimate） */
td {
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-size: var(--font-lg);
}
td.td-numfield {
  text-align: right;
}
td.td-numfield .cell-input {
  text-align: right;
}
tr.ghosty td {
  opacity: 0.55;
}
.td-title {
  word-break: break-word;
}
.td-src {
  color: var(--text-dim);
}
/* 行点击打开 item 抽屉（平台形态） */
tbody tr {
  cursor: pointer;
}
tbody tr:hover td {
  background: var(--bg-hover);
}
/* Title 单元格：状态图标 + 标题 + 灰色 #编号 */
.title-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.row-state {
  flex: none;
}
.title-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.td-ref {
  flex: none;
  color: var(--text-dim);
  font-size: var(--font-md);
}
/* 单选字段 pill（平台形态：浅色底 + 语义色字 + ▾ 就地改值） */
.pill-trigger {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}
.cell-pill {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 600;
}
.pill-caret {
  color: var(--text-dim);
}
/* 负责人单元格（平台：头像 + 名称 + ▾，点选改负责人） */
.assignee-cell {
  position: relative;
}
.assignee-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  border: none;
  background: transparent;
  padding: 0;
  color: var(--text);
  font-size: var(--font-lg);
  font-family: inherit;
  cursor: pointer;
}
.assignee-trigger:hover .assignee-name {
  text-decoration: underline;
}
.assignee-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  flex: none;
}
.assignee-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cell-select {
  font-size: var(--font-md);
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 4px;
}
/* 项目字段的就地编辑控件（下拉 / 文本·数字·日期输入） */
.cell-dd {
  min-width: 96px;
}
.cell-input {
  box-sizing: border-box;
  width: 100%;
  min-width: 80px;
  font-size: var(--font-md);
  font-family: inherit;
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 3px 6px;
  outline: none;
}
.cell-input:hover {
  border-color: var(--border);
}
.cell-input:focus {
  border-color: var(--accent);
  background: var(--bg-app);
}
/* 底部 add 行（平台：+ 在行号位、提示文案；点击展开内联输入）。
   高度与组内添加行/数据行统一为 40px 白区（全局「＋新增」行等高，
   曾用 padding 撑出不定高，实测翻车）；灰隙不在此行——它只属于组间 */
tfoot tr.add-row td {
  height: 40px;
  padding: 0 10px;
}
tfoot td {
  border-bottom: 1px solid var(--border);
}
.add-row {
  cursor: pointer;
}
.add-trigger {
  /* 块级（非 inline-flex）：inline 级会参与 td 行盒基线计算，把行高撑到
     内容高 + 下伸部（实测 44.5 > 38），导致添加行与其他行不一致 */
  display: flex;
  width: fit-content;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  cursor: pointer;
}
.add-trigger:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.add-input {
  width: 320px;
}
.tbl-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: var(--font-md);
  padding: 24px 0;
}
/* 泳道分组（平台 Group by 行）：白底横贯全宽、无列竖线；
   折叠 ⌄ + 色点 + 名称 + 计数胶囊 + 汇总 + ⋯ 隐藏 */
.tbl-grouprow > td {
  padding: 0;
}
.grp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 0 10px 0 20px;
  background: var(--bg-panel);
}
.grp-collapse {
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  color: var(--text-dim);
  padding: 2px;
  border-radius: 5px;
  cursor: pointer;
}
.grp-collapse:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.grp-dot {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
}
.grp-name {
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.grp-count {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 2px 6px;
  border-radius: 20px;
  background: #818b981f;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.grp-sum {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 9999px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 组头描述（平台 14px 常规次级色 → 桌面 13px token；③适配标注） */
.grp-desc {
  font-size: var(--font-base);
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 泳道分组的组间隙（平台每组 section 间 12px）：挂在每组「最后一个可见行」的
   border-bottom 上——border-bottom 向下绘制，不会像 border-top 那样在 collapse
   模型下向上叠进上一行的白盒（实测会啃掉 13px，添加行因此显矮）。
   · 展开组：最后一行 = 组内添加行（tbody 才有 add-row，扁平模式添加行在 tfoot 不命中）
   · 折叠组：最后一行 = 组头自身（--collapsed；这是 P1→P2 十轮无间隙的根因修复——
     折叠组没有添加行，间隙载体必须落到组头上） */
tbody tr.add-row > td,
.tbl-grouprow--collapsed > td {
  border-bottom: 12px solid var(--bg-app);
}
/* 全局 box-sizing: border-box 下 12px 灰隙计入行盒内部（会啃掉白区，实测添加行
   只剩 31.5px）；显式补高使白区与数据行一致。数据行实测渲染节距是 40px
   （td height 38 是 cell 的最小值语义，实际被行内容撑到 40），白区取 40：
   height = 40 白区 + 12 灰隙 = 52 */
tbody tr.add-row > td {
  height: 52px;
}
</style>
