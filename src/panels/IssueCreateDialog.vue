<script setup lang="ts">
/**
 * Issue 创建对话框（形制参照 GitHub issues/new）：左栏 = 标题 + 描述
 * （撰写/预览 Tab），右栏 = 负责人/标签/里程碑三个侧栏分区（清单来自
 * 平台：label_list / assignee_list，里程碑来自 store 缓存）。创建走
 * Source 写穿透——成功后新实体插列表顶部并选中之；失败错误横幅留在
 * 对话框内，输入不丢。本地仓库侧栏清单为空（journal v1 无对应字段）。
 */
import { computed, nextTick, ref, watch } from "vue";
import { api, isTauri, type LabelInfo } from "../api";
import { useIssuesStore } from "../stores/issues";
import { useRepoStore } from "../stores/repo";
import { useI18n } from "../i18n";
import { translateError } from "../gh-errors";
import MarkdownView from "../components/MarkdownView.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import EditorIcon from "../components/EditorIcon.vue";
import MarkdownToolbar from "../components/MarkdownToolbar.vue";
import { ISSUE_TOOLBAR_KEYS } from "../components/markdown-tools";
import { chipStyle } from "./label-chip";

const props = defineProps<{
  open: boolean;
  /** 看板流程：目标仓库候选（看板是跨仓库的，创建前需知落哪个仓库）。
   * 给了即进入 board 模式：标题写「Create new issue in <repo>」、直连该仓库创建、
   * 创建成功回传 created 由调用方加入看板。 */
  repoOptions?: { value: string; label: string; target: string }[];
  initialRepoId?: string;
  /** 项目名（board 模式：chips 行展示「项目」chip，平台同款）。 */
  projectLabel?: string;
}>();
const emit = defineEmits<{
  close: [];
  /** board 模式创建成功：回传编号/标题/所属仓库，由看板把新 Issue 加入对应格。 */
  created: [issue: { number: string; title: string; repoId: string }];
}>();

const store = useIssuesStore();
const repoStore = useRepoStore();
const { t } = useI18n();

// ---- board 模式（从看板创建）：目标仓库可选，侧栏清单按该仓库加载 ----
const boardMode = computed(() => !!props.repoOptions?.length);
const boardRepoId = ref("");
const boardLabels = ref<LabelInfo[]>([]);
const boardMilestones = ref<string[]>([]);
const activeRepo = computed(
  () => props.repoOptions?.find((r) => r.value === boardRepoId.value) ?? props.repoOptions?.[0] ?? null,
);
const repoChoices = computed(() => (props.repoOptions ?? []).map((r) => ({ value: r.value, label: r.label })));
async function loadBoardChoices() {
  const target = activeRepo.value?.target;
  if (!target) return;
  try {
    boardLabels.value = await api.labelList(target);
  } catch {
    boardLabels.value = [];
  }
  try {
    boardMilestones.value = (await api.milestoneList(target)).map((m) => m.title);
  } catch {
    boardMilestones.value = [];
  }
  try {
    assigneeChoices.value = await api.assigneeList(target);
  } catch {
    assigneeChoices.value = [];
  }
}
watch(
  () => props.open,
  (open) => {
    if (!open || !boardMode.value) return;
    boardRepoId.value = props.initialRepoId ?? props.repoOptions![0]!.value;
    void loadBoardChoices();
  },
);
watch(boardRepoId, () => {
  if (boardMode.value) void loadBoardChoices();
});

const title = ref("");
const body = ref("");
const descTab = ref<"write" | "preview">("write");
const milestone = ref("");
const labels = ref<string[]>([]);
const assignees = ref<string[]>([]);
const assigneeChoices = ref<string[]>([]);
// 内联新建标签（GitHub 线上无此入口——HiveTask 补的自定义能力）
const labelFormOpen = ref(false);
const newLabelName = ref("");
const newLabelColor = ref("#d73a4a");
const labelBusy = ref(false);
const creating = ref(false);
/** 描述区编辑器（工具条在光标处插入 Markdown）。 */
const bodyEl = ref<HTMLTextAreaElement | null>(null);
/** 工具条键序来自共享命令表（src/components/markdown-tools.ts），避免两份定义漂移。 */
/** 选区包裹（B/I/代码/链接/图片/@）。 */
function surroundSelection(prefix: string, suffix: string, placeholder: string) {
  const el = bodyEl.value;
  const start = el?.selectionStart ?? body.value.length;
  const end = el?.selectionEnd ?? body.value.length;
  const sel = body.value.slice(start, end) || placeholder;
  body.value = body.value.slice(0, start) + prefix + sel + suffix + body.value.slice(end);
  nextTick(() => {
    el?.focus();
    el?.setSelectionRange(start + prefix.length, start + prefix.length + sel.length);
  });
}
/** 行首前缀（标题/引用/列表/任务）。 */
function prefixLine(token: string) {
  const el = bodyEl.value;
  const start = el?.selectionStart ?? body.value.length;
  const lineStart = body.value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  body.value = body.value.slice(0, lineStart) + token + body.value.slice(lineStart);
  nextTick(() => el?.focus());
}
function applyToolbar(key: string) {
  switch (key) {
    case "h":
      return prefixLine("## ");
    case "b":
      return surroundSelection("**", "**", "bold text");
    case "i":
      return surroundSelection("*", "*", "italic text");
    case "quote":
      return prefixLine("> ");
    case "code":
      return surroundSelection("`", "`", "code");
    case "link":
      return surroundSelection("[", "](url)", "text");
    case "ul":
      return prefixLine("- ");
    case "ol":
      return prefixLine("1. ");
    case "task":
      return prefixLine("- [ ] ");
    case "image":
      return surroundSelection("![", "](url)", "alt");
    case "mention":
      return surroundSelection("@", "", "user");
    case "undo":
      return document.execCommand("undo");
  }
}
/** 「Create more」：创建后不关闭，便于连续建 Issue（平台同款）。 */
const createMore = ref(false);
const error = ref<string | null>(null);
// 附件引导提示（粘贴/拖入本地文件时的非阻塞说明；空 = 不显示）
const hint = ref<string | null>(null);

/** 标签候选：board 模式按目标仓库加载，否则用当前仓库缓存目录。 */
const labelChoices = computed(() => (boardMode.value ? boardLabels.value : store.labels));

/** 里程碑选项与里程碑 mode 组头同源（store 缓存，无额外远端调用）。 */
const milestoneChoices = computed(() =>
  boardMode.value ? boardMilestones.value : store.milestones.map((m) => m.title),
);

const canSubmit = computed(() => !!title.value.trim() && !creating.value);

/** 侧栏清单：负责人按仓库懒加载（非阻塞，失败静默为空——清单是增强信息）。 */
async function loadChoices(repo: string) {
  assigneeChoices.value = [];
  try {
    const as = await api.assigneeList(repo);
    if (repoStore.current !== repo) return;
    assigneeChoices.value = as;
  } catch {
    /* 清单拉取失败不阻塞创建 */
  }
}

/** 内联新建标签：写穿透 → 追加进 store 目录 → 自动勾选；失败落错误横幅。 */
async function submitLabel() {
  const name = newLabelName.value.trim();
  if (!name || labelBusy.value) return;
  labelBusy.value = true;
  error.value = null;
  try {
    if (store.labelColor(name) === null) {
      await store.addLabel(name, newLabelColor.value);
    }
    if (!labels.value.includes(name)) labels.value = toggleIn(labels.value, name);
    labelFormOpen.value = false;
    newLabelName.value = "";
  } catch (e) {
    error.value = translateError(String(e));
  } finally {
    labelBusy.value = false;
  }
}

// ---- 描述区附件（第一期：URL 引用；上传受平台能力矩阵约束，见知识库）----

const ATTACH_HINT_REMOTE = "issue.attachRemoteHint";

/** 图片扩展名粗判：URL 无扩展名时仍按图片插入（预览可看，成本为零）。 */
function looksLikeImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|$)/i.test(url);
}

/** 把 markdown 片段插入描述（追加 + 空行分隔，简单可预期）。 */
function appendToBody(snippet: string) {
  body.value = body.value ? `${body.value.replace(/\s+$/, "")}\n\n${snippet}` : snippet;
  descTab.value = "write";
}

/** 粘贴：图片 URL → markdown；本地文件按来源分流（远端诚实引导）。 */
function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  const url = text.trim();
  if (url && /^https?:\/\//i.test(url)) {
    event.preventDefault();
    const name = decodeURIComponent(url.split("/").pop() ?? "image");
    const alt = looksLikeImageUrl(url) ? name.replace(/\.[a-z0-9]+$/i, "") || "image" : name;
    appendToBody(`![${alt}](${url})`);
    return;
  }
  if (event.clipboardData?.files.length) {
    event.preventDefault();
    onLocalFiles(event.clipboardData.files.length);
  }
}

/** 本地文件拖入/粘贴：本地仓库收下提示（落盘后置），远端诚实引导上网页。 */
function onLocalFiles(count: number) {
  hint.value =
    repoStore.platform === "local"
      ? t("issue.attachLocalHint", { n: count })
      : t(ATTACH_HINT_REMOTE);
}

/** 拖拽悬停高亮 + 放下分流。 */
const dragging = ref(false);

function onDrop(event: DragEvent) {
  dragging.value = false;
  const url = event.dataTransfer?.getData("text/uri-list") || event.dataTransfer?.getData("text/plain") || "";
  const trimmed = url.trim();
  if (trimmed && /^https?:\/\//i.test(trimmed)) {
    const name = decodeURIComponent(trimmed.split("/").pop() ?? "image");
    const alt = looksLikeImageUrl(trimmed) ? name.replace(/\.[a-z0-9]+$/i, "") || "image" : name;
    appendToBody(`![${alt}](${trimmed})`);
    return;
  }
  if (event.dataTransfer?.files.length) {
    onLocalFiles(event.dataTransfer.files.length);
  }
}

async function submit() {
  if (!canSubmit.value) return;
  creating.value = true;
  error.value = null;
  try {
    if (boardMode.value) {
      const target = activeRepo.value?.target;
      if (!target) return;
      const fresh = await api.createIssue(
        target,
        title.value,
        body.value || undefined,
        milestone.value || undefined,
        labels.value.length ? labels.value : undefined,
        assignees.value.length ? assignees.value : undefined,
      );
      emit("created", { number: fresh.number, title: fresh.title, repoId: activeRepo.value?.value ?? "" });
      if (createMore.value) {
        resetKeepOpen();
      } else {
        reset();
        emit("close");
      }
      return;
    }
    await store.createIssue(
      title.value,
      body.value || undefined,
      milestone.value || undefined,
      labels.value.length ? labels.value : undefined,
      assignees.value.length ? assignees.value : undefined,
    );
    if (store.error) {
      error.value = store.error;
      return; // 留在对话框，输入不丢
    }
    if (createMore.value) {
      resetKeepOpen();
    } else {
      reset();
      emit("close");
    }
  } finally {
    creating.value = false;
  }
}

/** Create more：清空输入但保留对话框与侧栏选项。 */
function resetKeepOpen() {
  title.value = "";
  body.value = "";
  descTab.value = "write";
  hint.value = null;
  error.value = null;
}

function reset() {
  title.value = "";
  body.value = "";
  descTab.value = "write";
  milestone.value = "";
  labels.value = [];
  assignees.value = [];
  labelFormOpen.value = false;
  newLabelName.value = "";
  hint.value = null;
  error.value = null;
}

function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function onKeydown(event: KeyboardEvent) {
  // ⌘/Ctrl + Enter 提交（平台同款）
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    void submit();
    return;
  }
  if (event.key === "Escape" && !creating.value) emit("close");
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      reset();
      if (repoStore.current && isTauri()) {
        void store.loadMilestones(repoStore.current);
        void store.loadLabels(repoStore.current);
        void loadChoices(repoStore.current);
      }
    }
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ic-overlay" @click.self="!creating && emit('close')" @keydown="onKeydown">
      <div class="ic-card" role="dialog" :aria-label="t('issue.createTitle')">
        <div class="ic-topbar">
          <button v-if="!creating" class="ic-back" type="button" :title="t('common.close')" @click="emit('close')">
            <EditorIcon name="chevron" />
          </button>
          <h3 class="ic-title">
            {{ boardMode ? t("project.createIssueIn", { repo: activeRepo?.label ?? "" }) : t("issue.createTitle") }}
          </h3>
          <DropdownMenu
            v-if="boardMode && repoChoices.length > 1"
            class="ic-repo-dd"
            :options="repoChoices"
            :model-value="boardRepoId"
            @update:model-value="boardRepoId = $event as string"
          />
          <span class="ic-topbar-spacer"></span>
          <button v-if="!creating" class="ic-close" type="button" :aria-label="t('common.close')" @click="emit('close')">
            <EditorIcon name="o.x" />
          </button>
        </div>

        <p v-if="error" class="ic-error">{{ error }}</p>

        <div class="ic-body">
            <label class="ic-field-label">{{ t("issue.titleLabel") }} <b>*</b></label>
            <input
              v-model="title"
              class="ic-input ic-input-title"
              :placeholder="t('issue.titlePlaceholder')"
              spellcheck="false"
            />
            <label class="ic-field-label ic-field-label-desc">{{ t("issue.descLabel") }}</label>
            <div class="ic-editor">
            <div class="ic-editor-head">
              <div class="ic-tabs">
                <button
                  class="ic-tab"
                  :class="{ active: descTab === 'write' }"
                  @click="descTab = 'write'"
                >{{ t("issue.tabWrite") }}</button>
                <button
                  class="ic-tab"
                  :class="{ active: descTab === 'preview' }"
                  @click="descTab = 'preview'"
                >{{ t("issue.tabPreview") }}</button>
              </div>
              <!-- Markdown 工具条（Octicon 官方路径，平台同款；键序来自共享命令表） -->
              <MarkdownToolbar
                class="ic-toolbar"
                :groups="[ISSUE_TOOLBAR_KEYS]"
                size="form"
                @run="(command) => applyToolbar(command.key)"
              />
            </div>
            <textarea
              v-if="descTab === 'write'"
              ref="bodyEl"
              v-model="body"
              class="ic-textarea"
              :class="{ dragging }"
              :placeholder="t('issue.bodyPlaceholder')"
              rows="7"
              @paste="onPaste"
              @dragover.prevent="dragging = true"
              @dragleave="dragging = false"
              @drop.prevent="onDrop"
            />
            <div v-else-if="descTab === 'preview'" class="ic-preview">
              <MarkdownView v-if="body.trim()" :source="body" />
              <p v-else class="ic-preview-empty">{{ t("common.noBody") }}</p>
            </div>
            </div>
            <!-- 附件行（平台：Paste, drop, or click to add files） -->
            <div class="ic-attach-row">
              <button class="ic-attach" type="button" @click="onLocalFiles(1)">
                <EditorIcon name="o.paperclip" />
                {{ t("issue.attachRow") }}
              </button>
            </div>
            <p v-if="hint" class="ic-hint ic-hint-attach">{{ hint }}</p>

          <!-- 字段 chips 行（平台形态：虚线 chip 并排） -->
          <div class="ic-chips-row">
            <DropdownMenu
              class="ic-chip-dd"
              multiple
              :options="assigneeChoices.map((a) => ({ value: a, label: a }))"
              v-model="assignees"
              :placeholder="t('issue.sideAssignees')"
            />
            <DropdownMenu
              class="ic-chip-dd"
              multiple
              :options="labelChoices.map((l) => ({ value: l.name, label: l.name, color: l.color }))"
              v-model="labels"
              :placeholder="t('issue.sideLabels')"
            />
            <span v-if="projectLabel" class="ic-chip-static">
              <EditorIcon name="project.board" />
              {{ projectLabel }}
            </span>
            <DropdownMenu
              class="ic-chip-dd"
              :options="[{ value: '', label: t('issue.milestoneOptional') }, ...milestoneChoices.map((m) => ({ value: m, label: m }))]"
              v-model="milestone"
              :placeholder="t('issue.sideMilestone')"
            />
            <button class="ic-newlabel-toggle" @click="labelFormOpen = !labelFormOpen">
              {{ t("issue.newLabel") }}
            </button>
          </div>
          <div v-if="labels.length" class="ic-side-chips">
            <span
              v-for="n in labels"
              :key="n"
              class="ic-chip"
              :style="chipStyle(store.labelColor(n))"
            >{{ n }}</span>
          </div>
          <div v-if="labelFormOpen" class="ic-newlabel">
            <input
              v-model="newLabelName"
              class="ic-newlabel-name"
              :placeholder="t('issue.labelNamePh')"
              spellcheck="false"
            />
            <input
              v-model="newLabelColor"
              type="color"
              class="ic-newlabel-color"
              :title="t('issue.labelColor')"
            />
            <div class="ic-newlabel-actions">
              <button class="ic-newlabel-btn" @click="labelFormOpen = false">{{ t("conn.cancel") }}</button>
              <button
                class="ic-newlabel-btn primary"
                :disabled="labelBusy || !newLabelName.trim()"
                @click="submitLabel"
              >{{ t("issue.submit") }}</button>
            </div>
          </div>
        </div>

        <p class="ic-hint">{{ t("issue.createHint") }}</p>

        <div class="ic-actions">
          <label class="ic-create-more">
            <input v-model="createMore" type="checkbox" />
            {{ t("issue.createMore") }}
          </label>
          <span class="ic-actions-spacer"></span>
          <button class="ic-btn" :disabled="creating" @click="emit('close')">{{ t("conn.cancel") }}</button>
          <button class="ic-btn primary" :disabled="!canSubmit" @click="submit">
            {{ creating ? t("common.syncing") : t("issue.submit") }}
            <span class="ic-kbd">⌘⏎</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ic-overlay {
  position: fixed;
  inset: 0;
  z-index: 230;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.ic-card {
  width: 680px;
  max-width: calc(100vw - 40px);
  max-height: calc(100vh - 60px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 14px 16px;
}
/* 顶栏（平台形态：← + 标题 + ×） */
.ic-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.ic-back {
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  color: var(--text-dim);
  padding: 3px;
  border-radius: 5px;
  cursor: pointer;
  transform: rotate(180deg);
}
.ic-back:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.ic-topbar-spacer {
  flex: 1;
}
/* 字段标签（平台：Add a title * / Add a description） */
.ic-field-label {
  display: block;
  margin: 0 0 6px;
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.ic-field-label b {
  color: var(--danger);
}
.ic-field-label-desc {
  margin-top: 16px;
}
/* 编辑器框：页签 + 输入在同一个边框内（平台形态） */
.ic-attach-row {
  margin-top: 8px;
}
.ic-attach {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  font-family: inherit;
  padding: 2px 4px;
  border-radius: 5px;
  cursor: pointer;
}
.ic-attach:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.ic-kbd {
  margin-left: 6px;
  font-size: var(--font-sm);
  opacity: 0.65;
}
.ic-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.ic-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
}
.ic-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: 5px;
  cursor: pointer;
}
.ic-tool:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.ic-editor {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.ic-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}
/* 字段 chips 行（虚线 chip 并排，平台形态） */
.ic-chips-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
.ic-chip-dd {
  width: 150px;
}
.ic-chip-static {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 10px;
  border: 1px dashed var(--border);
  border-radius: 6px;
  font-size: var(--font-md);
  color: var(--text);
}
.ic-create-more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-md);
  color: var(--text);
  cursor: pointer;
}
.ic-actions-spacer {
  flex: 1;
}
.ic-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ic-title {
  margin: 0;
  font-size: var(--font-base);
  color: var(--text);
}
.ic-repo-dd {
  width: 180px;
  flex: none;
}
.ic-close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.ic-close:hover {
  color: var(--text);
}
.ic-error {
  margin: 0;
  padding: 7px 10px;
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
  word-break: break-all;
}
/* ---- 双栏（GitHub issues/new：左表单 + 右侧栏）---- */
.ic-columns {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.ic-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ic-side {
  flex: none;
  width: 180px;
  display: flex;
  flex-direction: column;
}
.ic-input,
.ic-textarea,
.ic-select {
  box-sizing: border-box;
  width: 100%;
  font-size: var(--font-md);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 6px 8px;
  outline: none;
  resize: vertical;
}
.ic-input-title {
  font-size: var(--font-base);
  padding: 8px 10px;
}
.ic-input:focus,
.ic-textarea:focus,
.ic-select:focus {
  border-color: var(--accent);
}
/* 拖拽悬停高亮 + 附件引导提示 */
.ic-textarea.dragging {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.ic-hint-attach {
  color: var(--accent);
}
/* 撰写 / 预览 Tab */
.ic-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}
.ic-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  padding: 4px 10px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.ic-tab:hover {
  color: var(--text);
}
.ic-tab.active {
  color: var(--text);
  font-weight: 600;
  border-bottom-color: var(--accent);
}
.ic-preview {
  box-sizing: border-box;
  min-height: 120px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  padding: 8px 10px;
}
.ic-preview-empty {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* ---- 侧栏分区（统一 DropdownMenu 组件）---- */
.ic-side-section {
  padding: 6px 0 8px;
  border-bottom: 1px solid var(--border);
}
.ic-side-section:last-child {
  border-bottom: none;
}
.ic-side-dd {
  width: 100%;
}
.ic-newlabel-toggle {
  margin-top: 6px;
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: var(--font-md);
  padding: 2px 0;
  cursor: pointer;
  text-align: left;
  width: 100%;
}
/* 已选标签回显：GitHub 式色底 chip */
.ic-side-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.ic-chip {
  display: inline-flex;
  align-items: center;
  font-size: var(--font-xs);
  font-weight: 600;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 9px;
  border: 1px solid transparent;
  white-space: nowrap;
}
/* 内联新建标签 */
.ic-newlabel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
}
.ic-newlabel-name {
  box-sizing: border-box;
  width: 100%;
  font-size: var(--font-md);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 4px 6px;
  outline: none;
}
.ic-newlabel-name:focus {
  border-color: var(--accent);
}
.ic-newlabel-color {
  width: 32px;
  height: 22px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  cursor: pointer;
}
.ic-newlabel-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.ic-newlabel-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-sm);
  height: 20px;
  padding: 0 8px;
  border-radius: 5px;
  cursor: pointer;
}
.ic-newlabel-btn.primary {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.ic-newlabel-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ic-side-empty {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
  padding: 4px 6px;
}
.ic-hint {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.ic-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.ic-btn {
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  height: 26px;
  padding: 0 12px;
  border-radius: 6px;
  cursor: pointer;
}
.ic-btn.primary {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.ic-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
