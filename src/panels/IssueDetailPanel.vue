<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import MarkdownView from "../components/MarkdownView.vue";
import CommentsSection from "../components/CommentsSection.vue";
import EditorIcon from "../components/EditorIcon.vue";
import MilestoneDetailView from "./MilestoneDetailView.vue";
import { stripHtmlComments } from "../components/markdown";
import { useIssuesStore } from "../stores/issues";
import { useRepoStore } from "../stores/repo";
import { useI18n } from "../i18n";
import { translateError } from "../gh-errors";
import { useCloseReopen } from "./close-reopen";
import { stateLabel } from "./state-label";
import { openOnLabel } from "./platform-label";
import { chipStyle } from "./label-chip";

defineProps<{ leafId?: string; panelType?: string }>();

const issues = useIssuesStore();
const repo = useRepoStore();
// 选中主体二选一：里程碑选中时右栏整体让位给里程碑详情（派生式，
// 无独立 mode 注册）。
const { selected, selectedMilestone } = storeToRefs(issues);
const { t } = useI18n();

// ---- 编辑态（查看 ⇄ 编辑显式切换）----
// 契约：保存 = 写穿透（失败留在编辑态，输入不丢，重试 = 再点保存）；
// Esc 等于取消（回到查看态，显示远端原值）。
const editing = ref(false);
const editTitle = ref("");
const editBody = ref("");
const saving = ref(false);
const editError = ref<string | null>(null);

function startEdit() {
  if (!selected.value) return;
  editTitle.value = selected.value.title;
  editBody.value = selected.value.body ?? "";
  editError.value = null;
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
  editError.value = null;
}

async function saveEdit() {
  const issue = selected.value;
  const title = editTitle.value.trim();
  if (!issue || !title || saving.value) return;
  saving.value = true;
  editError.value = null;
  try {
    await issues.updateIssue(issue.number, title, editBody.value.trim() || undefined);
    editing.value = false;
  } catch (e) {
    // 留在现场：编辑内容与错误横幅都保留，重试 = 再点保存
    editError.value = translateError(String(e));
  } finally {
    saving.value = false;
  }
}

const {
  armed: closeArmed,
  working: closeWorking,
  close: closeClick,
  reopen: reopenClick,
} = useCloseReopen(async (closed) => {
  if (issues.selected) await issues.setClosed(issues.selected, closed);
});

// Load the conversation whenever the selection changes. 编号是文本后不能用
// 真值判断（空串合法地代表"未选中"，而编号本身不可能为空串——但显式
// 判 null 才不依赖这个巧合）。
watch(
  () => issues.selected?.number,
  (number) => {
    if (number != null && number !== "") {
      void issues.loadComments(number);
      void issues.loadRelations(number);
    } else {
      issues.clearComments();
      issues.clearRelations();
    }
  },
  { immediate: true },
);

function onSubmitComment(body: string) {
  if (issues.selected) void issues.addComment(issues.selected.number, body);
}

/** 关系条有内容才渲染（四项全空 = 无能力来源或真无关系，都不摆空壳）。 */
const hasRelations = computed(() => {
  const r = issues.relations;
  return !!r && (!!r.parent || r.blockedBy.length > 0 || r.blocking.length > 0 || r.subIssues.length > 0);
});

function hasVisibleBody(body?: string | null): boolean {
  return !!body && stripHtmlComments(body).trim().length > 0;
}

/** 编辑态对选中主体失效即退出（切选中/切仓库/里程碑派生接管）。 */
watch(
  () => selected.value?.number,
  () => {
    if (editing.value) cancelEdit();
  },
);

const openBtnLabel = computed(() => openOnLabel(repo.platform));

function openUrl(url?: string | null) {
  if (!url) return;
  // opener plugin opens the system browser; in plain-browser preview fall
  // back to window.open.
  if ("__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));
  } else {
    window.open(url, "_blank", "noopener");
  }
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <MilestoneDetailView v-if="selectedMilestone" :title="selectedMilestone" />

    <template v-else-if="selected">
      <header class="detail-header">
        <div class="detail-title-row">
          <span class="detail-number">#{{ selected.number }}</span>
          <span class="detail-state" :class="selected.state.toLowerCase()">{{ stateLabel(selected.state) }}</span>
          <button
            class="state-action"
            :class="{ armed: closeArmed }"
            :disabled="closeWorking"
            :title="selected.state === 'OPEN' ? t('detail.closeHint') : t('detail.reopenHint')"
            @click="selected.state === 'OPEN' ? closeClick() : reopenClick()"
          >
            {{
              closeWorking
                ? t("detail.working")
                : selected.state === "OPEN"
                  ? closeArmed
                    ? t("detail.closeConfirm")
                    : t("detail.close")
                  : t("detail.reopen")
            }}
          </button>
          <button
            v-if="!editing"
            class="state-action"
            :title="t('detail.editHint')"
            @click="startEdit"
          >{{ t("detail.edit") }}</button>
        </div>

        <template v-if="!editing">
          <h2 class="detail-title">{{ selected.title }}</h2>
          <div class="detail-tags">
            <span
              v-for="label in selected.labels"
              :key="label"
              class="detail-label"
              :style="chipStyle(issues.labelColor(label))"
            >{{ label }}</span>
          </div>
        </template>
        <input
          v-else
          v-model="editTitle"
          class="edit-title"
          :placeholder="t('issue.titlePlaceholder')"
          spellcheck="false"
          @keydown.enter.prevent="saveEdit"
          @keydown.esc.prevent="cancelEdit"
        />
      </header>

      <div class="detail-body">
        <p v-if="editError" class="edit-error">{{ editError }}</p>

        <!-- 关系条（依赖 / 父子 / 子 Issue 进度）：详情级按需拉取；无能力的
             来源四项全空 → 整条不渲染（诚实缺席，不摆空壳）。v1 只读展示，
             不做跳转（关联 Issue 未必在当前筛选集，跳转另立项） -->
        <section v-if="hasRelations" class="detail-relations">
          <div v-if="issues.relations?.parent" class="rel-row">
            <span class="rel-label">{{ t("relations.parent") }}</span>
            <span class="rel-chip" :class="{ closed: issues.relations.parent.state === 'CLOSED' }">
              <EditorIcon :name="issues.relations.parent.state === 'CLOSED' ? 'o.issue-closed' : 'o.issue-opened'" />
              <span class="rel-num">#{{ issues.relations.parent.number }}</span>
              <span class="rel-title">{{ issues.relations.parent.title }}</span>
            </span>
          </div>
          <div v-if="issues.relations?.blockedBy.length" class="rel-row">
            <span class="rel-label">{{ t("relations.blockedBy") }}</span>
            <span
              v-for="r in issues.relations.blockedBy"
              :key="'b' + r.number"
              class="rel-chip"
              :class="{ closed: r.state === 'CLOSED' }"
            >
              <EditorIcon :name="r.state === 'CLOSED' ? 'o.issue-closed' : 'o.issue-opened'" />
              <span class="rel-num">#{{ r.number }}</span>
              <span class="rel-title">{{ r.title }}</span>
            </span>
          </div>
          <div v-if="issues.relations?.blocking.length" class="rel-row">
            <span class="rel-label">{{ t("relations.blocking") }}</span>
            <span
              v-for="r in issues.relations.blocking"
              :key="'k' + r.number"
              class="rel-chip"
              :class="{ closed: r.state === 'CLOSED' }"
            >
              <EditorIcon :name="r.state === 'CLOSED' ? 'o.issue-closed' : 'o.issue-opened'" />
              <span class="rel-num">#{{ r.number }}</span>
              <span class="rel-title">{{ r.title }}</span>
            </span>
          </div>
          <div v-if="issues.relations?.subIssues.length" class="rel-row">
            <span class="rel-label">{{ t("relations.subIssues") }}</span>
            <span v-if="issues.relations.subSummary" class="rel-count">
              {{ issues.relations.subSummary.completed }}/{{ issues.relations.subSummary.total }}
            </span>
            <span
              v-for="r in issues.relations.subIssues"
              :key="'s' + r.number"
              class="rel-chip"
              :class="{ closed: r.state === 'CLOSED' }"
            >
              <EditorIcon :name="r.state === 'CLOSED' ? 'o.issue-closed' : 'o.issue-opened'" />
              <span class="rel-num">#{{ r.number }}</span>
              <span class="rel-title">{{ r.title }}</span>
            </span>
          </div>
        </section>

        <template v-if="!editing">
          <MarkdownView v-if="hasVisibleBody(selected.body)" :source="selected.body" />
          <p v-else class="detail-nobody">{{ t("common.noBody") }}</p>
        </template>
        <template v-else>
          <textarea
            v-model="editBody"
            class="edit-body"
            :placeholder="t('issue.bodyPlaceholder')"
            rows="10"
            spellcheck="false"
          ></textarea>
          <div class="edit-actions">
            <button class="edit-btn" :disabled="saving" @click="cancelEdit">
              {{ t("conn.cancel") }}
            </button>
            <button class="edit-btn primary" :disabled="saving || !editTitle.trim()" @click="saveEdit">
              {{ saving ? t("common.syncing") : t("detail.save") }}
            </button>
          </div>
        </template>

        <CommentsSection
          :comments="issues.comments"
          :loading="issues.commentsLoading"
          :submitting="issues.commentSubmitting"
          @submit="onSubmitComment"
        />
      </div>

      <footer class="detail-footer">
        <div class="detail-people">
          <template v-if="!editing">
            <template v-if="selected.author">{{ t("common.author", { name: selected.author }) }}</template>
            <template v-if="selected.assignees.length">
              　·　{{ t("common.assignees", { name: selected.assignees.join(", ") }) }}
            </template>
          </template>
          <button v-else class="edit-entry" @click="cancelEdit">{{ t("detail.cancelEdit") }}</button>
        </div>
        <button
          v-if="!editing && selected.url && openBtnLabel"
          class="open-github"
          @click="openUrl(selected.url)"
        >
          {{ openBtnLabel }}
        </button>
      </footer>
    </template>

    <div v-else class="detail-empty">
      <p v-if="repo.current">{{ t("issue.emptySelect") }}</p>
      <p v-else>{{ t("issue.emptyRepo") }}</p>
    </div>
  </PanelShell>
</template>

<style scoped>
.detail-header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.detail-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.detail-number {
  font-size: var(--font-base);
  color: var(--text-dim);
}
.state-action {
  margin-left: auto;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-sm);
  height: 22px;
  padding: 0 12px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.state-action:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}
.state-action.armed:not(:disabled) {
  border-color: var(--danger);
  background: var(--danger-soft);
  color: var(--danger);
}
/* 组内第二个管理按钮（编辑）贴着前一个，不再参与右推 */
.state-action + .state-action {
  margin-left: 0;
}
.state-action:disabled {
  opacity: 0.5;
  cursor: default;
}
.detail-state {
  font-size: var(--font-sm);
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 10px;
}
.detail-state.open {
  color: var(--success);
  background: var(--success-soft);
}
.detail-state.closed {
  color: var(--merged);
  background: var(--merged-soft);
}
.detail-title {
  margin: 8px 0 8px;
  font-size: var(--font-xl);
  font-weight: 600;
  color: var(--text);
  line-height: 1.4;
}
.detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.detail-label {
  font-size: var(--font-sm);
  padding: 2px 9px;
  border-radius: 12px;
  background: var(--bg-chip);
  color: var(--text-dim);
  border: 1px solid var(--border);
}
/* 关系条：标签列 + 可换行的 chip 流（依赖/父子/子 Issue） */
.detail-relations {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.rel-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.rel-label {
  min-width: 64px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.rel-count {
  font-size: var(--font-xs);
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-chip);
  color: var(--text-dim);
  border: 1px solid var(--border);
}
.rel-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 380px;
  padding: 2px 9px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-chip);
  font-size: var(--font-sm);
  color: var(--text);
}
.rel-chip.closed {
  color: var(--text-dim);
}
.rel-chip .rel-num {
  color: var(--text-dim);
  flex: none;
}
.rel-chip .rel-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}
.detail-nobody {
  color: var(--text-dim);
  font-size: var(--font-base);
}
.detail-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 20px;
  border-top: 1px solid var(--border);
  font-size: var(--font-md);
  color: var(--text-dim);
}
.open-github {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--accent);
  font-size: var(--font-md);
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.open-github:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}
/* ---- 编辑态（查看 ⇄ 编辑显式切换）---- */
.edit-title {
  box-sizing: border-box;
  width: 100%;
  margin-top: 8px;
  font-size: var(--font-xl);
  font-weight: 600;
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  outline: none;
}
.edit-title:focus {
  border-color: var(--accent);
}
.edit-error {
  margin: 0 0 10px;
  padding: 7px 10px;
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
  word-break: break-all;
}
.edit-body {
  box-sizing: border-box;
  width: 100%;
  font-size: var(--font-base);
  font-family: inherit;
  line-height: 1.5;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  outline: none;
  resize: vertical;
}
.edit-body:focus {
  border-color: var(--accent);
}
.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.edit-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  height: 26px;
  padding: 0 14px;
  border-radius: 6px;
  cursor: pointer;
}
.edit-btn.primary {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.edit-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.edit-entry {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: var(--font-md);
  cursor: pointer;
  padding: 0;
}
.detail-empty {
  margin: auto;
  color: var(--text-dim);
  font-size: var(--font-base);
  text-align: center;
}
</style>
