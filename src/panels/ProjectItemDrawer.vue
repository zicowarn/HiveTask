<script setup lang="ts">
/**
 * Project item 右侧抽屉（平台 item side panel 复刻；登录态 DOM 实测 2026-09-16）：
 *   浮层面板（圆角 12、宽 ≈90% 视口、整体滚动）；
 *   左主列 = 标题 + #编号 外链 + ✏️ → 状态/仓库徽标行（实心胶囊 + 仓库 pill 含
 *   Private 小签）→ 正文会话（作者头 strip + ⋯ 菜单 + Markdown 正文 + 评论 +
 *   关闭/重开 与 评论按钮）；
 *   右栏 = 平台 Metadata 分区：负责人（头像行）/ 标签（彩 chip）/ Projects
 *   设置卡（项目名 + Status 下拉常显 + 其余字段折叠展开）/ 里程碑。
 *   自适应：面板 ≥720px 双列，<720px 右栏堆叠（ResizeObserver；平台断点 ≈768）。
 *
 * 字号遵循项目五档 token（详情页标题 --font-xl、内容 --font-base、UI --font-md），
 * 不照抄平台网页的 32px 网页比例（③适配标注）。
 *
 * 诚实边界（不摆空控件、不造假）：
 *  - 草稿卡：标题/正文走 project_item_update_draft，无会话与状态；
 *  - Issue 引用卡：标题/正文 update_issue 写穿透；评论 add_comment；
 *    关闭/重开 set_issue_state（两击确认，与 Issues 详情同口径）；
 *  - PR 引用卡：标题/正文只读，评论可读可写（kind=pull），无开闭按钮；
 *  - 悬挂卡（ghost）：只读 + 可移除；
 *  - 平台头部 Pin、时间线事件、Copy link in project、Archive in project、
 *    Relationships / Development / Notifications / Participants 分区、
 *    负责人/标签的编辑齿轮——均无数据面或写通道，挂账不摆空控件。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api, type LabelInfo, type MilestoneInfo, type ProjectField, type ProjectItem } from "../api";
import type { Comment } from "../types";
import { translateError } from "../gh-errors";
import { useProjectsStore } from "../stores/projects";
import { useI18n } from "../i18n";
import { pushToast } from "../toast";
import SideDrawer from "../components/SideDrawer.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import ActionMenu, { type ActionItem } from "../components/ActionMenu.vue";
import MetaPicker from "../components/MetaPicker.vue";
import EditorIcon from "../components/EditorIcon.vue";
import MarkdownView from "../components/MarkdownView.vue";
import { chipStyle } from "./label-chip";
import { itemTitle, kindLabel, shortDate } from "./item-fields";
import { stateLabel } from "./state-label";

const props = defineProps<{
  open: boolean;
  item: ProjectItem | null;
}>();
const emit = defineEmits<{ close: []; open: [item: ProjectItem] }>();

const store = useProjectsStore();
const { t } = useI18n();

const titleDraft = ref("");
const titleEditing = ref(false);
const bodyDraft = ref("");
const bodyOriginal = ref("");
const bodyEditing = ref(false);
const bodyLoading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);

/** 仓库登记表 id → target / visibility（写穿透、外链与徽标都要；抽屉自带）。 */
const repoMeta = ref<Record<string, { target: string; visibility: string | null }>>({});
async function loadRepoMeta() {
  if (Object.keys(repoMeta.value).length) return;
  try {
    const rows = (await api.repoList()) as Array<{
      id: string;
      path?: string | null;
      remoteUrl?: string | null;
      visibility?: string | null;
    }>;
    const map: Record<string, { target: string; visibility: string | null }> = {};
    for (const row of rows) {
      map[row.id] = { target: row.path ?? row.remoteUrl ?? row.id, visibility: row.visibility ?? null };
    }
    repoMeta.value = map;
  } catch {
    repoMeta.value = {};
  }
}
function metaOf(repoId: string | null) {
  if (!repoId) return null;
  return repoMeta.value[repoId] ?? null;
}

/** 引用条目的线上地址（remote + issues|pull + 编号）。 */
function issueUrl(item: ProjectItem | null): string | null {
  if (!item || item.kind === "draft" || item.ghost || !item.repoId || !item.number) return null;
  const remote = metaOf(item.repoId)?.target ?? "";
  if (!/^https?:\/\//.test(remote)) return null;
  const base = remote.replace(/\.git$/, "").replace(/\/+$/, "");
  return `${base}/${item.kind === "pull" ? "pull" : "issues"}/${item.number}`;
}
/** GitHub 头像（非 GitHub 来源不摆，避免错图）。 */
function avatarOf(author: string | null | undefined, size = 64): string | null {
  if (!author) return null;
  const url = issueUrl(props.item);
  return url && url.includes("github.com") ? `https://github.com/${author}.png?size=${size}` : null;
}
function openExternal(url: string) {
  if ("__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));
  } else {
    window.open(url, "_blank", "noopener");
  }
}
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    pushToast({ kind: "info", message: t("project.copied") });
  } catch {
    pushToast({ kind: "error", message: t("project.copyFailed") });
  }
}

/** 元数据可编辑 = 有实体（引用卡 + 非悬挂 + 能解析 target）；草稿/悬挂隐藏编辑入口。 */
const metaEditable = computed(() => {
  const item = props.item;
  return !!item && item.kind !== "draft" && !item.ghost && !!metaOf(item.repoId)?.target;
});

/** 会话可用 = 有仓库缓存的引用条目（评论 / 正文 / 状态）。 */
const conversation = computed(() => {
  const item = props.item;
  return !!item && !item.ghost && (item.kind === "issue" || item.kind === "pull") && !!metaOf(item.repoId)?.target;
});
const commentKind = computed(() => (props.item?.kind === "pull" ? "pull" : "issue") as "issue" | "pull");

// ---- 评论（cache-first → 平台新鲜回填；写穿透乐观 pending 行） ----
const comments = ref<Comment[]>([]);
const commentsLoading = ref(false);
const commentDraft = ref("");
const commentSending = ref(false);
const commentBox = ref<HTMLTextAreaElement | null>(null);
async function loadComments(target: string, number: string) {
  commentsLoading.value = true;
  try {
    const cached = await api.listCachedComments(target, commentKind.value, number);
    comments.value = cached;
    const fresh = await api.fetchComments(target, commentKind.value, number);
    comments.value = fresh;
  } catch {
    /* 评论读取失败不阻塞抽屉 */
  } finally {
    commentsLoading.value = false;
  }
}
async function submitComment() {
  const item = props.item;
  const target = metaOf(item?.repoId ?? null)?.target;
  const body = commentDraft.value.trim();
  if (!item || !target || !item.number || !body || commentSending.value) return;
  commentSending.value = true;
  comments.value.push({ body, pending: true });
  try {
    comments.value = await api.addComment(target, commentKind.value, item.number, body);
    commentDraft.value = "";
  } catch (e) {
    comments.value = comments.value.filter((c) => !c.pending);
    error.value = translateError(String(e));
  } finally {
    commentSending.value = false;
  }
}
function onCommentKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submitComment();
}
/** 引用回复：正文逐行 > 引用进评论框。 */
function quoteReply() {
  const body = bodyDraft.value.trim();
  if (!body) return;
  commentDraft.value = body.split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
  void nextTick(() => commentBox.value?.focus());
}

// ---- 打开 / 换条目：重置草稿；引用卡拉缓存正文 + 评论 + 标签色板 ----
const labelInfos = ref<LabelInfo[]>([]);
const milestones = ref<MilestoneInfo[]>([]);
const assigneeOptions = ref<string[]>([]);
async function hydrate() {
  error.value = null;
  titleEditing.value = false;
  bodyEditing.value = false;
  closeMenuOpen.value = false;
  comments.value = [];
  commentDraft.value = "";
  labelInfos.value = [];
  const item = props.item;
  if (!item) return;
  titleDraft.value = itemTitle(item);
  bodyDraft.value = item.kind === "draft" ? (item.draftBody ?? "") : "";
  bodyOriginal.value = bodyDraft.value;
  await loadRepoMeta();
  const target = metaOf(item.repoId)?.target;
  if (item.kind !== "issue" || !item.number || !target) return;
  // 在线刷新条目缓存（gh 拉源 + 替换缓存）：负责人/标签/状态镜像才不会陈旧；
  // 离线/失败不阻塞（回落本地缓存）
  try {
    await api.refreshIssues(target, "all", 100);
  } catch {
    /* 离线容忍 */
  }
  bodyLoading.value = true;
  try {
    const rows = await api.listCachedIssues(target, "all");
    if (props.item?.id !== item.id) return;
    const hit = rows.find((r) => r.number === item.number);
    bodyDraft.value = hit?.body ?? "";
    bodyOriginal.value = bodyDraft.value;
  } catch {
    /* 正文读取失败不阻塞——用户仍可写入 */
  } finally {
    bodyLoading.value = false;
  }
  if (item.number) void loadComments(target, item.number);
  try {
    labelInfos.value = await api.labelList(target);
  } catch {
    labelInfos.value = [];
  }
  try {
    milestones.value = await api.milestoneList(target);
  } catch {
    milestones.value = [];
  }
  try {
    assigneeOptions.value = await api.assigneeList(target);
  } catch {
    assigneeOptions.value = [];
  }
}
watch(
  () => [props.open, props.item?.id],
  () => {
    if (props.open) void hydrate();
  },
  { immediate: true },
);

/** 头部身份行（小字；主标题在内容区，平台同款）。 */
const identity = computed(() => {
  const item = props.item;
  if (!item) return t("project.taskPanelTitle");
  const kind = kindLabel(item);
  if (item.ghost) return kind + " · " + t("project.ghost");
  return item.number ? `${kind} #${item.number}` : kind;
});

const stateText = computed(() => stateLabel(props.item?.entity?.state));
const isStateOpen = computed(() => {
  const s = (props.item?.entity?.state ?? "").toUpperCase();
  return s !== "CLOSED" && s !== "MERGED";
});
const stateClass = computed(() => (isStateOpen.value ? "open" : "closed"));
const stateIcon = computed(() => (isStateOpen.value ? "o.issue-opened" : "o.issue-closed"));

const isDraft = computed(() => props.item?.kind === "draft");
const isIssue = computed(() => props.item?.kind === "issue");
const isGhost = computed(() => !!props.item?.ghost);
/** 标题可编辑：草稿 / Issue（写通道存在）；PR 与悬挂只读。 */
const titleEditable = computed(() => (isDraft.value || isIssue.value) && !isGhost.value);
const bodyEditable = computed(() => (isDraft.value || isIssue.value) && !isGhost.value);

const repoVisibilityLabel = computed(() => {
  const v = metaOf(props.item?.repoId ?? null)?.visibility;
  if (v === "private") return t("visibility.private");
  if (v === "public") return t("visibility.public");
  return "";
});

// ---- 右栏 Metadata 数据 ----
const assignees = computed(() => props.item?.entity?.assignees ?? []);
const milestoneText = computed(() => props.item?.entity?.milestone ?? "");
interface LabelChip {
  name: string;
  style?: ReturnType<typeof chipStyle>;
}
const labelChips = computed<LabelChip[]>(() => {
  const names = props.item?.entity?.labels ?? [];
  return names.map((name) => {
    const info = labelInfos.value.find((l) => l.name === name);
    return { name, style: chipStyle(info?.color) };
  });
});
/** 参与者 = 作者 + 评论者去重（数据面：会话已加载）。 */
const participants = computed(() => {
  const out: string[] = [];
  const author = props.item?.entity?.author;
  if (author) out.push(author);
  for (const c of comments.value) {
    if (c.author && !out.includes(c.author)) out.push(c.author);
  }
  return out;
});

// ---- 齿轮选值（GitHub 形态：区头下浮出筛选面板，点击行即写穿透）----
/** 仅在线 Issue 开放（gh/Gitea 写通道；本地 journal v2 待办、PR 不开放 → 「暂不支持」标签）。 */
const canEditMeta = computed(() => conversation.value && isIssue.value);
/** 当前展开的面板（同时刻最多一个）。 */
const pickerOpen = ref<"" | "assignees" | "labels" | "milestone">("");
function togglePicker(name: "assignees" | "labels" | "milestone") {
  pickerOpen.value = pickerOpen.value === name ? "" : name;
}
const assigneeChoiceOptions = computed(() =>
  assigneeOptions.value.map((a) => ({
    value: a,
    label: a,
    avatar: avatarOf(a, 40),
  })),
);
const milestoneChoice = computed(() => milestoneText.value);

async function setMilestone(name: string) {
  const item = props.item;
  const target = metaOf(item?.repoId ?? null)?.target;
  if (!item || !target || !item.number) return;
  try {
    await api.issueUpdateMilestone(target, item.number, name || null);
    await store.refreshSelected();
  } catch (e) {
    error.value = translateError(String(e));
  } finally {
    pickerOpen.value = "";
  }
}
async function setLabelNames(next: string | string[]) {
  const item = props.item;
  const target = metaOf(item?.repoId ?? null)?.target;
  if (!item || !target || !item.number) return;
  try {
    await api.issueUpdateLabels(target, item.number, Array.isArray(next) ? next : [next]);
    await store.refreshSelected();
  } catch (e) {
    error.value = translateError(String(e));
  }
}
async function setAssignees(next: string | string[]) {
  const item = props.item;
  const target = metaOf(item?.repoId ?? null)?.target;
  if (!item || !target || !item.number) return;
  try {
    await api.issueUpdateAssignees(target, item.number, Array.isArray(next) ? next : [next]);
    await store.refreshSelected();
  } catch (e) {
    error.value = translateError(String(e));
  }
}

// ---- Projects 设置卡：默认展开（用户定案），caret 可收起 ----
const projExpanded = ref(true);
const statusRow = computed(() =>
  projectFields.value.find((r) => r.field.kind === "builtin_status") ?? null,
);
const otherRows = computed(() =>
  projectFields.value.filter((r) => r !== statusRow.value),
);

// ---- 项目字段（状态 / 优先级 / 自建）：看板字段全集 ----
const projectFields = computed(() =>
  store.fieldCatalogue
    .filter((f) => f.section === "project")
    .map((f) => ({ name: f.name, field: store.fieldByViewKey(f.id) }))
    .filter((r): r is { name: string; field: ProjectField } => !!r.field),
);
function fieldValue(field: ProjectField): string {
  return props.item?.fieldValues[field.id] ?? "";
}
function isSelect(field: ProjectField): boolean {
  return field.kind === "single_select" || field.kind === "builtin_status";
}
function optionsOf(field: ProjectField) {
  return [
    { value: "", label: t("project.none") },
    ...field.options.map((o) => ({ value: o.id, label: o.name, color: o.color })),
  ];
}
function inputType(field: ProjectField): string {
  return field.kind === "number" ? "number" : field.kind === "date" ? "date" : "text";
}
async function setFieldValue(field: ProjectField, value: string) {
  const item = props.item;
  if (!item) return;
  await store.setFieldValue(item.id, field.id, value || undefined);
}

/** 标题转编辑态并把焦点交回输入框。 */
const titleInput = ref<HTMLInputElement | null>(null);
function startTitleEdit() {
  titleEditing.value = true;
  void nextTick(() => titleInput.value?.focus());
}

/** 保存标题 + 描述（草稿走 updateDraft；Issue 走 Source 写穿透）。 */
async function saveText() {
  const item = props.item;
  if (!item || !titleEditable.value || saving.value) return;
  const title = titleDraft.value.trim();
  if (!title) {
    titleDraft.value = itemTitle(item);
    return;
  }
  if (title === itemTitle(item) && bodyDraft.value === bodyOriginal.value) return;
  saving.value = true;
  error.value = null;
  try {
    if (item.kind === "draft") {
      await store.updateDraft(item.id, title, bodyDraft.value);
      bodyOriginal.value = bodyDraft.value;
      return;
    }
    const target = metaOf(item.repoId)?.target;
    if (!target || !item.number) return;
    await api.updateIssue(target, item.number, title, bodyDraft.value);
    await store.refreshSelected();
    bodyOriginal.value = bodyDraft.value;
  } catch (e) {
    error.value = translateError(String(e));
  } finally {
    saving.value = false;
  }
}

// ---- 关闭 / 重开（平台分体按钮：Close issue ⌄ → 三种关闭理由；单击即关）----
type CloseReason = "completed" | "not_planned" | "duplicate";
const closeReason = ref<CloseReason>("completed");
const closeMenuOpen = ref(false);
const closeMenuRoot = ref<HTMLElement | null>(null);
const closeReasons = computed(() => [
  {
    value: "completed" as const,
    title: t("project.closeAsCompleted"),
    desc: t("project.closeCompletedDesc"),
    icon: "o.issue-closed",
    color: "var(--merged)",
  },
  {
    value: "not_planned" as const,
    title: t("project.closeAsNotPlanned"),
    desc: t("project.closeNotPlannedDesc"),
    icon: "o.skip",
    color: "var(--text-dim)",
  },
  {
    value: "duplicate" as const,
    title: t("project.closeAsDuplicate"),
    desc: t("project.closeDuplicateDesc"),
    icon: "o.skip",
    color: "var(--text-dim)",
  },
]);
const closeReasonGh = (r: CloseReason): string =>
  r === "completed" ? "completed" : r === "not_planned" ? "not planned" : "duplicate";
async function closeIssue() {
  const item = props.item;
  const target = metaOf(item?.repoId ?? null)?.target;
  if (!item || !isIssue.value || isGhost.value || !target || !item.number) return;
  closeMenuOpen.value = false;
  try {
    await api.setIssueState(target, item.number, true, closeReasonGh(closeReason.value));
    await store.refreshSelected();
  } catch (e) {
    error.value = translateError(String(e));
  }
}
async function toggleState() {
  const item = props.item;
  const target = metaOf(item?.repoId ?? null)?.target;
  if (!item || !isIssue.value || isGhost.value || !target || !item.number) return;
  try {
    await api.setIssueState(target, item.number, false, null);
    await store.refreshSelected();
  } catch (e) {
    error.value = translateError(String(e));
  }
}
function onDocPointerDown(event: MouseEvent) {
  if (closeMenuOpen.value && closeMenuRoot.value && !closeMenuRoot.value.contains(event.target as Node)) {
    closeMenuOpen.value = false;
  }
}
watch(closeMenuOpen, (open) => {
  if (open) {
    document.addEventListener("pointerdown", onDocPointerDown);
  } else {
    document.removeEventListener("pointerdown", onDocPointerDown);
  }
});
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocPointerDown));

// ---- 头部动作与 ⋯ 菜单 ----
function openInWorkspace() {
  const item = props.item;
  if (item && item.repoId && item.number) emit("open", item);
}
async function removeItem() {
  const item = props.item;
  if (!item) return;
  await store.removeItem(item.id);
  emit("close");
}

// ---- 侧栏底部操作（克隆 / 锁定 / 删除；转移与置顶挂账为标签）----
const lockedUi = ref(false);
async function toggleLocked() {
  const item = props.item;
  const target = metaOf(item?.repoId ?? null)?.target;
  if (!item || !target || !item.number) return;
  try {
    await api.issueSetLocked(target, item.number, !lockedUi.value);
    lockedUi.value = !lockedUi.value;
    pushToast({ kind: "info", message: lockedUi.value ? t("project.locked") : t("project.unlocked") });
  } catch (e) {
    error.value = translateError(String(e));
  }
}
async function cloneIssue() {
  const item = props.item;
  const target = metaOf(item?.repoId ?? null)?.target;
  if (!item || !target) return;
  try {
    const created = await api.createIssue(
      target,
      itemTitle(item),
      bodyDraft.value || undefined,
      milestoneText.value || undefined,
      item.entity?.labels ?? [],
      item.entity?.assignees ?? [],
    );
    pushToast({ kind: "info", message: t("project.clonedTo", { n: created.number }) });
  } catch (e) {
    error.value = translateError(String(e));
  }
}
async function deleteIssue() {
  const item = props.item;
  const target = metaOf(item?.repoId ?? null)?.target;
  if (!item || !target || !item.number) return;
  if (!confirm(t("project.deleteIssueConfirm", { name: itemTitle(item) }))) return;
  try {
    await api.issueDelete(target, item.number);
    await store.removeItem(item.id);
    emit("close");
  } catch (e) {
    error.value = translateError(String(e));
  }
}
const drawerMenu = computed<ActionItem[]>(() => {
  const out: ActionItem[] = [];
  // 「在新标签页中打开」是浏览器语境动作，桌面端不落（用户定案 2026-09-16）
  out.push({ value: "copyLink", label: t("project.actCopyLink"), icon: "o.copy", dividerBefore: false });
  out.push({
    value: "remove",
    label: t("project.actRemoveFromProject"),
    icon: "o.trash",
    danger: true,
    badge: "Del",
    dividerBefore: true,
  });
  return out;
});
async function onDrawerMenu(value: string) {
  const url = issueUrl(props.item);
  if (value === "copyLink" && url) await copyText(url);
  else if (value === "remove") await removeItem();
}
const convMenu = computed<ActionItem[]>(() => {
  const out: ActionItem[] = [
    { value: "copyLink", label: t("project.actCopyLink"), icon: "o.copy" },
    { value: "copyMd", label: t("project.copyMarkdown"), icon: "o.copy" },
    { value: "quote", label: t("project.quoteReply"), icon: "o.md-quote" },
  ];
  if (bodyEditable.value) out.push({ value: "edit", label: t("project.bodyEdit"), icon: "o.edit", dividerBefore: true });
  return out;
});
async function onConvMenu(value: string) {
  if (value === "copyLink") {
    const url = issueUrl(props.item);
    if (url) await copyText(url);
  } else if (value === "copyMd") {
    await copyText(bodyDraft.value);
  } else if (value === "quote") {
    quoteReply();
  } else if (value === "edit") {
    bodyEditing.value = true;
    void nextTick(() => document.getElementById("pd-body-input")?.focus());
  }
}

// ---- 自适应：面板 ≥720px 双列，否则右栏堆叠（平台断点 ≈768） ----
const gridEl = ref<HTMLElement | null>(null);
const wide = ref(true);
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver((entries) => {
    for (const entry of entries) wide.value = entry.contentRect.width >= 720;
  });
  if (gridEl.value) ro.observe(gridEl.value);
});
onBeforeUnmount(() => ro?.disconnect());
</script>

<template>
  <SideDrawer
    :open="open"
    :title="identity"
    width="min(1168px, 90vw)"
    top="44px"
    floating
    @close="emit('close')"
  >
    <template #header-actions>
      <button
        v-if="item && item.repoId && item.number && !item.ghost"
        class="pd-icon-btn"
        type="button"
        :title="t('project.openInWorkspace')"
        :aria-label="t('project.openInWorkspace')"
        @click="openInWorkspace"
      >
        <EditorIcon name="o.arrow-right" />
      </button>
      <button
        v-if="issueUrl(item)"
        class="pd-icon-btn"
        type="button"
        :title="t('project.actCopyLink')"
        :aria-label="t('project.actCopyLink')"
        @click="issueUrl(item) && copyText(issueUrl(item)!)"
      >
        <EditorIcon name="o.copy" />
      </button>
      <ActionMenu
        v-if="item"
        class="pd-head-menu"
        trigger-icon="ellipsis"
        :title="t('project.actItemMenu')"
        :items="drawerMenu"
        @pick="onDrawerMenu"
      />
    </template>

    <p v-if="error" class="pd-error">{{ error }}</p>

    <div v-if="item" ref="gridEl" class="pd-grid" :class="{ wide }">
      <!-- ================= 左主列 ================= -->
      <div class="pd-main">
        <!-- 标题行：标题 + #编号（外链）+ ✏️ -->
        <div class="pd-titlerow">
          <input
            v-if="titleEditing && titleEditable"
            ref="titleInput"
            v-model="titleDraft"
            class="pd-title-input"
            :placeholder="t('issue.titlePlaceholder')"
            spellcheck="false"
            @blur="((titleEditing = false), saveText())"
            @keydown.enter.prevent="((titleEditing = false), saveText())"
          />
          <h2 v-else class="pd-title">
            <span>{{ itemTitle(item) }}</span>
            <a
              v-if="issueUrl(item)"
              class="pd-num"
              :title="issueUrl(item) ?? ''"
              @click.prevent="issueUrl(item) && openExternal(issueUrl(item)!)"
              :href="issueUrl(item) ?? '#'"
              >#{{ item.number }}</a
            >
          </h2>
          <button
            v-if="titleEditable && !titleEditing"
            class="pd-icon-btn"
            type="button"
            :title="t('common.edit')"
            :aria-label="t('common.edit')"
            @click="startTitleEdit"
          >
            <EditorIcon name="o.edit" />
          </button>
        </div>

        <!-- 徽标行：状态实心胶囊 + 仓库 pill（含 Private 小签） -->
        <div class="pd-badges">
          <span v-if="stateText" class="pd-state" :class="stateClass">
            <EditorIcon :name="stateIcon" />
            {{ stateText }}
          </span>
          <span v-if="item.repoLabel && !item.ghost" class="pd-repo">
            <EditorIcon name="o.repo" />
            <span class="pd-repo-name">{{ item.repoLabel }}</span>
            <span v-if="repoVisibilityLabel" class="pd-visibility">{{ repoVisibilityLabel }}</span>
          </span>
        </div>

        <!-- 正文会话（引用条目） -->
        <template v-if="conversation">
          <div class="pd-convhead">
            <img
              v-if="avatarOf(item.entity?.author)"
              class="pd-avatar"
              :src="avatarOf(item.entity?.author)!"
              alt=""
            />
            <span class="pd-convhead-text">
              <b>{{ item.entity?.author ?? "—" }}</b>
              {{ t("project.openedOn") }}
              <span>{{ shortDate(item.entity?.createdAt) }}</span>
            </span>
            <span class="pd-convhead-spacer"></span>
            <ActionMenu
              trigger-icon="ellipsis"
              :title="t('project.actItemMenu')"
              :items="convMenu"
              @pick="onConvMenu"
            />
          </div>

          <div class="pd-body">
            <textarea
              v-if="bodyEditing || (isDraft && bodyEditable)"
              id="pd-body-input"
              v-model="bodyDraft"
              class="pd-body-input"
              rows="8"
              :placeholder="bodyLoading ? t('common.syncing') : t('issue.bodyPlaceholder')"
              spellcheck="false"
              @blur="saveText"
            ></textarea>
            <MarkdownView v-else-if="bodyDraft.trim()" :source="bodyDraft" />
            <p v-else-if="item.kind === 'pull'" class="pd-note">{{ t("project.prReadonly") }}</p>
            <p v-else class="pd-note">{{ t("common.noBody") }}</p>
          </div>

          <!-- 动态：评论列表 + 评论框 + 关闭/重开 -->
          <section class="pd-activity">
            <h3 class="pd-sec-title">{{ t("project.activity") }}</h3>
            <p v-if="commentsLoading" class="pd-note">{{ t("common.syncing") }}</p>
            <p v-else-if="comments.length === 0" class="pd-note">{{ t("comments.empty") }}</p>
            <div v-for="(c, ci) in comments" :key="ci" class="pd-comment">
              <div class="pd-comment-head">
                <b>{{ c.author ?? "—" }}</b>
                <span>{{ shortDate(c.createdAt) }}</span>
              </div>
              <MarkdownView v-if="!c.pending" :source="c.body ?? ''" />
              <p v-else class="pd-note">{{ t("comments.sending") }}</p>
            </div>

            <h4 class="pd-compose-title">{{ t("project.addComment") }}</h4>
            <textarea
              ref="commentBox"
              v-model="commentDraft"
              class="pd-compose"
              :placeholder="t('comments.placeholder')"
              spellcheck="false"
              @keydown="onCommentKeydown"
            ></textarea>
            <div class="pd-compose-foot">
              <!-- 平台分体按钮：主钮 = 按当前理由关闭；⌄ = 选理由（上行菜单） -->
              <div v-if="isIssue && !isGhost && isStateOpen" ref="closeMenuRoot" class="pd-split">
                <button class="pd-btn" type="button" @click="closeIssue">
                  <EditorIcon :name="closeReasons.find((r) => r.value === closeReason)?.icon ?? 'o.issue-closed'" />
                  {{ t("detail.close") }}
                </button>
                <button
                  class="pd-btn pd-split-caret"
                  type="button"
                  :title="t('project.metaSettings')"
                  :aria-label="t('project.metaSettings')"
                  @click="closeMenuOpen = !closeMenuOpen"
                >
                  <EditorIcon name="o.chevron-down" />
                </button>
                <div v-if="closeMenuOpen" class="pd-close-menu">
                  <button
                    v-for="r in closeReasons"
                    :key="r.value"
                    class="pd-close-row"
                    type="button"
                    @click="((closeReason = r.value), closeIssue())"
                  >
                    <EditorIcon v-if="closeReason === r.value" class="pd-close-check" name="o.check" />
                    <span v-else class="pd-close-check"></span>
                    <EditorIcon class="pd-close-icon" :name="r.icon" :style="{ color: r.color }" />
                    <span class="pd-close-text">
                      <b>{{ r.title }}</b>
                      <span>{{ r.desc }}</span>
                    </span>
                  </button>
                </div>
              </div>
              <button
                v-else-if="isIssue && !isGhost"
                class="pd-btn reopen"
                type="button"
                @click="toggleState"
              >
                <EditorIcon name="o.issue-opened" />
                {{ t("detail.reopen") }}
              </button>
              <span class="pd-compose-spacer"></span>
              <button
                class="pd-btn primary"
                type="button"
                :disabled="!commentDraft.trim() || commentSending"
                @click="submitComment"
              >
                {{ commentSending ? t("comments.sending") : t("comments.send") }}
              </button>
            </div>
          </section>
        </template>

        <!-- 草稿正文（无会话）：直接编辑 -->
        <div v-else-if="isDraft" class="pd-body">
          <textarea
            v-if="bodyEditable"
            v-model="bodyDraft"
            class="pd-body-input"
            rows="8"
            :placeholder="t('issue.bodyPlaceholder')"
            spellcheck="false"
            @blur="saveText"
          ></textarea>
        </div>
        <p v-else-if="item.ghost" class="pd-note">{{ t("project.ghost") }}</p>
      </div>

      <!-- ================= 右栏：Metadata 分区（平台同构；齿轮 = 后续 gh 操作入口） ================= -->
      <aside class="pd-side">
        <!-- 负责人（在线 Issue：齿轮 → 筛选面板多选；否则「暂不支持」标签） -->
        <section class="pd-side-sec">
          <div class="pd-side-head">
            <h3 class="pd-side-title">{{ store.fieldName("assignees") }}</h3>
            <template v-if="canEditMeta">
              <button
                class="pd-gear"
                type="button"
                :class="{ on: pickerOpen === 'assignees' }"
                :title="t('project.metaSettings')"
                :aria-label="t('project.metaSettings')"
                @click="togglePicker('assignees')"
              >
                <EditorIcon name="o.gear" />
              </button>
              <MetaPicker
                :open="pickerOpen === 'assignees'"
                multiple
                :options="assigneeChoiceOptions"
                :selected="assignees"
                :placeholder="t('project.filterAssignees')"
                @close="pickerOpen = ''"
                @toggle="setAssignees"
              />
            </template>
            <span v-else class="pd-tag">{{ t("project.unsupported") }}</span>
          </div>
          <div v-for="a in assignees" :key="a" class="pd-asg">
            <img v-if="avatarOf(a, 40)" class="pd-asg-avatar" :src="avatarOf(a, 40)!" alt="" />
            <span>{{ a }}</span>
          </div>
          <p v-if="assignees.length === 0" class="pd-side-empty">{{ t("project.metaNone") }}</p>
        </section>

        <!-- 标签（在线 Issue：齿轮 → 筛选面板多选，带色点） -->
        <section class="pd-side-sec">
          <div class="pd-side-head">
            <h3 class="pd-side-title">{{ store.fieldName("labels") }}</h3>
            <template v-if="canEditMeta">
              <button
                class="pd-gear"
                type="button"
                :class="{ on: pickerOpen === 'labels' }"
                :title="t('project.metaSettings')"
                :aria-label="t('project.metaSettings')"
                @click="togglePicker('labels')"
              >
                <EditorIcon name="o.gear" />
              </button>
              <MetaPicker
                :open="pickerOpen === 'labels'"
                multiple
                :options="labelInfos.map((l) => ({ value: l.name, label: l.name, color: l.color }))"
                :selected="item.entity?.labels ?? []"
                :placeholder="t('project.filterLabels')"
                @close="pickerOpen = ''"
                @toggle="setLabelNames"
              />
            </template>
            <span v-else class="pd-tag">{{ t("project.unsupported") }}</span>
          </div>
          <div v-if="labelChips.length" class="pd-labels">
            <span v-for="l in labelChips" :key="l.name" class="pd-label" :style="l.style">{{ l.name }}</span>
          </div>
          <p v-else class="pd-side-empty">{{ t("project.metaNone") }}</p>
        </section>

        <!-- Projects 设置卡：项目名 + 字段行（默认展开） -->
        <section class="pd-side-sec">
          <div class="pd-side-head">
            <h3 class="pd-side-title">{{ t("project.metaProjects") }}</h3>
            <button
              v-if="metaEditable"
              class="pd-gear"
              type="button"
              :title="t('project.metaSettings')"
              :aria-label="t('project.metaSettings')"
            >
              <EditorIcon name="o.gear" />
            </button>
          </div>
          <div class="pd-project">
            <div class="pd-project-head">
              <EditorIcon name="o.layout-board" />
              <b>{{ store.selected?.displayName ?? "—" }}</b>
            </div>
            <div v-if="statusRow" class="pd-project-row">
              <span class="pd-field-name">{{ statusRow.name }}</span>
              <DropdownMenu
                class="pd-field-dd"
                :options="optionsOf(statusRow.field)"
                :model-value="fieldValue(statusRow.field)"
                :placeholder="t('project.none')"
                @update:model-value="setFieldValue(statusRow.field, $event as string)"
              />
            </div>
            <template v-if="projExpanded">
              <div v-for="row in otherRows" :key="row.field.id" class="pd-project-row">
                <span class="pd-field-name">{{ row.name }}</span>
                <DropdownMenu
                  v-if="isSelect(row.field)"
                  class="pd-field-dd"
                  :options="optionsOf(row.field)"
                  :model-value="fieldValue(row.field)"
                  :placeholder="t('project.none')"
                  @update:model-value="setFieldValue(row.field, $event as string)"
                />
                <input
                  v-else
                  class="pd-field-input"
                  :type="inputType(row.field)"
                  :value="fieldValue(row.field)"
                  @change="setFieldValue(row.field, ($event.target as HTMLInputElement).value)"
                />
              </div>
            </template>
            <button
              v-if="otherRows.length"
              class="pd-project-toggle"
              type="button"
              :aria-label="t('project.fieldsToggle')"
              @click="projExpanded = !projExpanded"
            >
              <EditorIcon name="o.chevron-down" :class="{ flip: projExpanded }" />
            </button>
          </div>
        </section>

        <!-- 里程碑（在线 Issue：齿轮 → 筛选面板单选含「无」，选后关闭；否则「暂不支持」标签） -->
        <section class="pd-side-sec">
          <div class="pd-side-head">
            <h3 class="pd-side-title">{{ store.fieldName("milestone") }}</h3>
            <template v-if="canEditMeta">
              <button
                class="pd-gear"
                type="button"
                :class="{ on: pickerOpen === 'milestone' }"
                :title="t('project.metaSettings')"
                :aria-label="t('project.metaSettings')"
                @click="togglePicker('milestone')"
              >
                <EditorIcon name="o.gear" />
              </button>
              <MetaPicker
                :open="pickerOpen === 'milestone'"
                :multiple="false"
                :options="[
                  { value: '', label: t('project.none') },
                  ...milestones.map((m) => ({ value: m.title, label: m.title })),
                ]"
                :selected="milestoneChoice ? [milestoneChoice] : []"
                :placeholder="t('project.filterMilestones')"
                @close="pickerOpen = ''"
                @toggle="setMilestone"
              />
            </template>
            <span v-else class="pd-tag">{{ t("project.unsupported") }}</span>
          </div>
          <p class="pd-side-value">{{ milestoneText || t("project.none") }}</p>
        </section>

        <!-- 关系：数据面挂账（需 issue↔PR 关联缓存） -->
        <section class="pd-side-sec">
          <div class="pd-side-head">
            <h3 class="pd-side-title">{{ t("project.metaRelationships") }}</h3>
            <span class="pd-tag">{{ t("project.unsupported") }}</span>
          </div>
          <p class="pd-side-empty">{{ t("project.metaNone") }}</p>
        </section>

        <!-- 开发：数据面挂账（Create a branch / link a PR 需关联写通道） -->
        <section class="pd-side-sec">
          <div class="pd-side-head">
            <h3 class="pd-side-title">{{ t("project.metaDevelopment") }}</h3>
            <span class="pd-tag">{{ t("project.unsupported") }}</span>
          </div>
          <p class="pd-side-empty">{{ t("project.metaNone") }}</p>
        </section>

        <!-- 参与者 -->
        <section class="pd-side-sec">
          <h3 class="pd-side-title">{{ t("project.metaParticipants") }}</h3>
          <div v-for="p in participants" :key="p" class="pd-asg">
            <img v-if="avatarOf(p, 40)" class="pd-asg-avatar" :src="avatarOf(p, 40)!" alt="" />
            <span>{{ p }}</span>
          </div>
          <p v-if="participants.length === 0" class="pd-side-empty">{{ t("project.metaNone") }}</p>
        </section>

        <!-- 操作（平台侧栏底部动作列；不适用的行内挂「暂不支持」小签） -->
        <section v-if="conversation && isIssue" class="pd-side-sec">
          <h3 class="pd-side-title">{{ t("project.metaActions") }}</h3>
          <button class="pd-act" type="button" @click="cloneIssue">
            <EditorIcon name="o.copy" />
            <span>{{ t("project.actClone") }}</span>
          </button>
          <button class="pd-act" type="button" @click="toggleLocked">
            <EditorIcon name="lock" />
            <span>{{ lockedUi ? t("project.actUnlock") : t("project.actLock") }}</span>
          </button>
          <div class="pd-act na">
            <EditorIcon name="o.arrow-right" />
            <span>{{ t("project.actTransfer") }}</span>
            <span class="pd-tag">{{ t("project.unsupported") }}</span>
          </div>
          <div class="pd-act na">
            <EditorIcon name="o.pin" />
            <span>{{ t("project.actPin") }}</span>
            <span class="pd-tag">{{ t("project.unsupported") }}</span>
          </div>
          <button class="pd-act danger" type="button" @click="deleteIssue">
            <EditorIcon name="o.trash" />
            <span>{{ t("project.actDeleteIssue") }}</span>
          </button>
        </section>
      </aside>
    </div>

    <template #footer>
      <button v-if="item" class="pd-btn danger" type="button" @click="removeItem">
        {{ t("project.actRemoveFromProject") }}
      </button>
      <span class="pd-foot-spacer"></span>
      <span v-if="saving" class="pd-saving">{{ t("common.syncing") }}</span>
    </template>
  </SideDrawer>
</template>

<style scoped>
/* 让出应用 header（44px，PanelShell 实测）与浮层面板形态经 SideDrawer 的
   top / floating props 直传（Teleport 根上 attrs 透传不可靠，勿用 class 选择器） */
.pd :deep(.sd-body) {
  padding: 20px 24px;
}
.pd-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  cursor: pointer;
}
.pd-icon-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.pd-error {
  margin: 0 0 10px;
  padding: 7px 10px;
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
  word-break: break-all;
}
/* 双列：主列 70% / 右栏 30%（用户定案：主列收窄到七成）；
   <720px 堆叠（平台断点 ≈768，实测） */
.pd-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
}
.pd-grid.wide {
  grid-template-columns: minmax(0, 70fr) 30fr;
  gap: 32px;
}
/* ---- 标题行（详情页标题档 = --font-xl；编号次级下划线外链） ---- */
.pd-titlerow {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.pd-title {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: var(--font-xl);
  font-weight: 600;
  line-height: 24px;
  color: var(--text);
  word-break: break-word;
}
.pd-num {
  color: var(--text-dim);
  text-decoration: underline;
  cursor: pointer;
}
.pd-title-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  font-size: var(--font-base);
  font-weight: 600;
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--accent);
  border-radius: 6px;
  padding: 7px 9px;
  outline: none;
}
/* ---- 徽标行（实心胶囊 + 仓库 pill + Private 小签；尺寸随桌面字号档收敛） ---- */
.pd-badges {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.pd-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: var(--font-md);
  font-weight: 600;
  color: #fff;
}
.pd-state.open {
  background: var(--success);
}
.pd-state.closed {
  background: var(--merged);
}
.pd-repo {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: var(--font-md);
  color: var(--text);
}
.pd-repo .editor-icon {
  color: var(--text-dim);
}
.pd-repo-name {
  font-weight: 600;
}
.pd-visibility {
  height: 16px;
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 500;
  color: var(--text);
  background: var(--bg-chip);
}
/* ---- 正文会话 ---- */
.pd-convhead {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
  padding: 5px 10px;
  border-radius: 6px;
  background: var(--accent-soft);
  font-size: var(--font-md);
  color: var(--text);
}
.pd-avatar {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}
.pd-convhead-text b {
  font-weight: 600;
}
.pd-convhead-text > span {
  color: var(--text-dim);
}
.pd-convhead-spacer {
  flex: 1;
}
.pd-body {
  margin-top: 12px;
  font-size: var(--font-base);
  line-height: 1.55;
  color: var(--text);
  word-break: break-word;
}
.pd-body-input {
  box-sizing: border-box;
  width: 100%;
  font-size: var(--font-base);
  font-family: inherit;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 9px 12px;
  outline: none;
  resize: vertical;
}
.pd-body-input:focus {
  border-color: var(--accent);
}
.pd-note {
  margin: 0;
  font-size: var(--font-md);
  color: var(--text-dim);
}
/* ---- 动态（评论） ---- */
.pd-activity {
  margin-top: 24px;
}
.pd-sec-title {
  margin: 0 0 10px;
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.pd-comment {
  padding: 10px 0;
  border-top: 1px solid var(--border);
  font-size: var(--font-md);
}
.pd-comment-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.pd-comment-head b {
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--text);
}
.pd-comment-head span {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.pd-compose-title {
  margin: 14px 0 6px;
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--text);
}
.pd-compose {
  box-sizing: border-box;
  width: 100%;
  min-height: 84px;
  font-size: var(--font-base);
  font-family: inherit;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 9px 12px;
  outline: none;
  resize: vertical;
}
.pd-compose:focus {
  border-color: var(--accent);
}
.pd-compose-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.pd-compose-spacer {
  flex: 1;
}
/* 关闭分体按钮（平台 Close issue ⌄）：主钮 + 竖排 caret，菜单向上弹出 */
.pd-split {
  position: relative;
  display: inline-flex;
}
.pd-split .pd-btn:first-child {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.pd-split-caret {
  border-left: none;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  padding: 0 6px;
}
.pd-close-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 95;
  width: 320px;
  padding: 6px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
}
.pd-close-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.pd-close-row:hover {
  background: var(--bg-hover);
}
.pd-close-row + .pd-close-row {
  border-top: 1px solid var(--border);
  border-radius: 0;
}
.pd-close-row + .pd-close-row:hover {
  border-radius: 6px;
}
.pd-close-check {
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  color: var(--text);
}
.pd-close-icon {
  flex: none;
  margin-top: 1px;
}
.pd-close-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.pd-close-text b {
  font-size: var(--font-md);
  font-weight: 600;
}
.pd-close-text span {
  font-size: var(--font-md);
  color: var(--text-dim);
}
.pd-btn.reopen {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--success);
  border-color: var(--success);
}
.pd-btn.reopen:hover {
  background: var(--success-soft);
  border-color: var(--success);
}
/* 侧栏底部操作行（平台：图标 + 名称，Delete 红字；不适用行内挂小签） */
.pd-act {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.pd-act .editor-icon {
  flex: none;
  color: var(--text-dim);
}
.pd-act:hover {
  background: var(--bg-hover);
}
.pd-act span {
  flex: 1;
  min-width: 0;
}
.pd-act.na {
  cursor: default;
}
.pd-act.na:hover {
  background: transparent;
}
.pd-act.na span:first-of-type {
  color: var(--text-dim);
}
.pd-act.danger {
  color: var(--danger);
}
.pd-act.danger .editor-icon {
  color: var(--danger);
}
.pd-btn {
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  font-family: inherit;
  cursor: pointer;
}
.pd-btn:hover {
  border-color: var(--text-dim);
}
.pd-btn.primary {
  background: var(--btn-primary);
  border-color: var(--btn-primary-border);
  color: #fff;
}
.pd-btn.primary:hover {
  background: var(--btn-primary-hover);
}
.pd-btn.primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.pd-btn.danger {
  color: var(--danger);
  border-color: var(--danger);
}
/* ---- 右栏 Metadata 分区（平台段标题 12px/600 次级色） ---- */
.pd-side-sec + .pd-side-sec {
  margin-top: 20px;
}
.pd-side-head {
  position: relative; /* MetaPicker 锚点 */
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 8px;
}
.pd-side-title {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--text-dim);
}
.pd-gear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: 5px;
  cursor: pointer;
}
.pd-gear:hover,
.pd-gear.on {
  color: var(--text);
  background: var(--bg-hover);
}
/* 「暂不支持」小标签（el-tag 形态：描边圆角小签，次级色） */
.pd-tag {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-chip);
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.pd-side-empty {
  margin: 0;
  font-size: var(--font-md);
  color: var(--text-dim);
}
.pd-side-value {
  margin: 0;
  font-size: var(--font-md);
  color: var(--text);
  word-break: break-word;
}
.pd-asg {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  font-size: var(--font-md);
  color: var(--text);
}
.pd-asg-avatar {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}
.pd-labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.pd-label {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: var(--font-xs);
  font-weight: 600;
}
/* Projects 设置卡（平台：描边圆角卡 + 项目名 + 字段行 + 折叠 caret） */
.pd-project {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 10px 6px;
}
.pd-project-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  font-size: var(--font-md);
  color: var(--text);
}
.pd-project-head .editor-icon {
  color: var(--text-dim);
}
.pd-project-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-top: 1px solid var(--border);
}
.pd-field-name {
  flex: none;
  width: 72px;
  font-size: var(--font-md);
  color: var(--text-dim);
}
.pd-field-dd {
  flex: 1;
  min-width: 0;
}
.pd-field-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  font-size: var(--font-md);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 4px 7px;
  outline: none;
}
.pd-field-input:focus {
  border-color: var(--accent);
}
.pd-project-toggle {
  display: flex;
  justify-content: center;
  width: 100%;
  padding: 2px 0 0;
  border: none;
  border-top: 1px solid var(--border);
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.pd-project-toggle:hover {
  color: var(--text);
}
.pd-project-toggle .editor-icon {
  transition: transform 0.12s;
}
.pd-project-toggle .editor-icon.flip {
  transform: rotate(180deg);
}
.pd-foot-spacer {
  flex: 1;
}
.pd-saving {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
</style>
