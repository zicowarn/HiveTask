<script setup lang="ts">
/**
 * 里程碑详情（issue.detail 面板的派生视图）：issues store 选中主体是
 * 里程碑时由 IssueDetailPanel 渲染。头部结构与 Issue 详情对齐——状态行
 * （徽标 + 关闭/重开 + 编辑）、标题、截止/进度、描述；页脚「在 {平台}
 * 打开」。meta 读 store（每仓库缓存，点组头秒开）；关闭/编辑走写穿透，
 * 结果按平台编号回填 store，组头与详情同步刷新。关联 commit 口径：
 * message 引用组内 Issue 编号（#42）即计入。
 */
import { computed, ref, watch } from "vue";
import IssueRow from "./IssueRow.vue";
import MarkdownView from "../components/MarkdownView.vue";
import { api, isTauri } from "../api";
import { useRepoStore } from "../stores/repo";
import { useIssuesStore } from "../stores/issues";
import { useI18n } from "../i18n";
import { translateError } from "../gh-errors";
import { openOnLabel } from "./platform-label";
import { stateLabel } from "./state-label";
import { useCloseReopen } from "./close-reopen";
import type { GitCommitRow, Issue } from "../types";

const props = defineProps<{ title: string }>();

const repoStore = useRepoStore();
const issuesStore = useIssuesStore();
const { t } = useI18n();

const openBtnLabel = computed(() => openOnLabel(repoStore.platform));

/** 本体元数据：store 单一来源（组头/详情/写穿透回填共享）。 */
const meta = computed(() => issuesStore.milestones.find((m) => m.title === props.title) ?? null);

const issues = ref<Issue[]>([]);
const commits = ref<GitCommitRow[]>([]);
const commitsLoading = ref(false);
const error = ref<string | null>(null);
const expandedOid = ref<string | null>(null);

const total = computed(() =>
  meta.value ? meta.value.openIssues + meta.value.closedIssues : issues.value.length,
);
const done = computed(
  () => meta.value?.closedIssues ?? issues.value.filter((i) => i.state === "CLOSED").length,
);
const progress = computed(() => (total.value > 0 ? Math.round((done.value / total.value) * 100) : 0));

/** 截止信息：逾期（红）→ 截止日；已关闭里程碑不提示逾期。 */
const due = computed<{ text: string; overdue: boolean } | null>(() => {
  if (!meta.value?.dueOn) return null;
  const at = new Date(meta.value.dueOn);
  if (Number.isNaN(at.getTime())) return null;
  const overdueDays = Math.ceil((Date.now() - at.getTime()) / 86_400_000);
  if (overdueDays > 0 && meta.value.state !== "closed") {
    return { text: t("milestone.overdueBy", { n: overdueDays }), overdue: true };
  }
  return { text: t("milestone.dueBy", { date: meta.value.dueOn.slice(0, 10) }), overdue: false };
});

/** 平台里程碑才有本体操作（本地"里程碑"是 Issue 文本标签，number=0）。 */
const manageable = computed(() => (meta.value?.number ?? 0) > 0);

// ---- 关闭 / 重开（与 Issue 详情同一两击确认契约）----
const { armed: closeArmed, working: closeWorking, close, reopen } = useCloseReopen(
  async (closed) => {
    if (!meta.value) return;
    try {
      await issuesStore.setMilestoneState(meta.value, closed);
    } catch (e) {
      error.value = translateError(String(e));
    }
  },
);

// ---- 编辑态（查看 ⇄ 编辑显式切换；失败留现场，重试 = 再点保存）----
const editing = ref(false);
const editTitle = ref("");
const editDesc = ref("");
const editDue = ref("");
const saving = ref(false);
const editError = ref<string | null>(null);

function startEdit() {
  if (!meta.value) return;
  editTitle.value = meta.value.title;
  editDesc.value = meta.value.description ?? "";
  editDue.value = meta.value.dueOn?.slice(0, 10) ?? "";
  editError.value = null;
  editing.value = true;
}

function cancelEdit() {
  editing.value = false;
  editError.value = null;
}

async function saveEdit() {
  const m = meta.value;
  const name = editTitle.value.trim();
  if (!m || !name || saving.value) return;
  saving.value = true;
  editError.value = null;
  try {
    const fresh = await issuesStore.updateMilestone(
      m,
      name,
      editDesc.value.trim() || undefined,
      editDue.value || undefined,
    );
    editing.value = false;
    // 名称变了：选中跟随新名（props.title 经选中态流转）
    if (fresh.title !== props.title) issuesStore.selectMilestone(fresh.title);
  } catch (e) {
    editError.value = translateError(String(e));
  } finally {
    saving.value = false;
  }
}

// ---- 数据（Issue 清单走本地缓存；关联 commit 懒加载）----
async function load() {
  const repo = repoStore.current;
  const wanted = props.title; // await 后选中可能已切换，旧结果不落地
  if (!isTauri() || !repo || !wanted) return;
  issues.value = [];
  commits.value = [];
  expandedOid.value = null;
  try {
    const cached = await api.listCachedIssues(repo, "all");
    if (repoStore.current !== repo || props.title !== wanted) return;
    issues.value = cached.filter((i) => i.milestone === wanted);
  } catch (e) {
    if (repoStore.current === repo && props.title === wanted) error.value = translateError(String(e));
    return;
  }
  void loadCommits(repo, wanted);
}

/** 关联 commit 是增强信息：失败静默为空列表，不影响上半部分。 */
async function loadCommits(repo: string, wanted: string) {
  commitsLoading.value = true;
  try {
    const page = await api.gitHistory(repo, 500);
    if (repoStore.current !== repo || props.title !== wanted) return;
    const numbers = new Set(issues.value.map((i) => i.number));
    const seen = new Set<string>();
    commits.value = page.commits
      .filter((c) => {
        if (seen.has(c.oid)) return false;
        seen.add(c.oid);
        return [...c.message.matchAll(/#(\d+)/g)].some((m) => numbers.has(m[1]));
      })
      .sort((a, b) => b.committedAtUnix - a.committedAtUnix);
  } catch {
    commits.value = [];
  } finally {
    commitsLoading.value = false;
  }
}

function toggleCommit(oid: string) {
  expandedOid.value = expandedOid.value === oid ? null : oid;
}

function dateOf(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function openOnline(url?: string | null) {
  if (!url) return;
  if ("__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));
  } else {
    window.open(url, "_blank", "noopener");
  }
}

watch(
  () => [props.title, repoStore.current] as const,
  () => void load(),
  { immediate: true },
);
</script>

<template>
  <div class="msd-scroll">
    <template v-if="meta || issues.length > 0">
      <header class="msd-head">
        <div class="msd-title-row">
          <span v-if="meta" class="msd-state" :class="meta.state">{{ stateLabel(meta.state) }}</span>
          <span class="msd-spacer"></span>
          <template v-if="manageable && !editing">
            <button
              class="msd-action"
              :class="{ armed: closeArmed }"
              :disabled="closeWorking"
              :title="meta?.state === 'open' ? t('milestone.closeHint') : t('milestone.reopenHint')"
              @click="meta?.state === 'open' ? close() : reopen()"
            >
              {{
                closeWorking
                  ? t("detail.working")
                  : meta?.state === "open"
                    ? closeArmed
                      ? t("detail.closeConfirm")
                      : t("detail.close")
                    : t("detail.reopen")
              }}
            </button>
            <button class="msd-action" :title="t('milestone.editHint')" @click="startEdit">
              {{ t("detail.edit") }}
            </button>
          </template>
        </div>

        <template v-if="!editing">
          <h2 class="msd-title">{{ title }}</h2>
          <div class="msd-meta">
            <span v-if="due" class="msd-due" :class="{ overdue: due.overdue }">{{ due.text }}</span>
            <span class="msd-progress" :title="t('milestone.progressTitle', { done, total })">
              <span class="msd-track"><span class="msd-fill" :style="{ width: progress + '%' }"></span></span>
              {{ done }}/{{ total }}
            </span>
          </div>
        </template>
        <template v-else>
          <input
            v-model="editTitle"
            class="msd-edit-title"
            :placeholder="t('milestone.namePh')"
            spellcheck="false"
            @keydown.esc.prevent="cancelEdit"
          />
          <div class="msd-edit-row">
            <label class="msd-edit-label" for="msd-due">{{ t("milestone.dueLabel") }}</label>
            <input id="msd-due" v-model="editDue" type="date" class="msd-edit-date" />
          </div>
        </template>

        <p v-if="editError" class="msd-edit-error">{{ editError }}</p>
        <MarkdownView v-if="!editing && meta?.description" class="msd-desc" :source="meta.description" />
        <template v-else-if="editing">
          <textarea
            v-model="editDesc"
            class="msd-edit-desc"
            :placeholder="t('milestone.descPh')"
            rows="4"
            spellcheck="false"
          ></textarea>
          <div class="msd-edit-actions">
            <button class="msd-btn" :disabled="saving" @click="cancelEdit">{{ t("conn.cancel") }}</button>
            <button class="msd-btn primary" :disabled="saving || !editTitle.trim()" @click="saveEdit">
              {{ saving ? t("common.syncing") : t("detail.save") }}
            </button>
          </div>
        </template>
      </header>

      <section class="msd-section">
        <h3 class="msd-section-title">{{ t("milestone.detail.issues", { n: issues.length }) }}</h3>
        <ul class="msd-issues">
          <IssueRow v-for="issue in issues" :key="issue.number" :issue="issue" />
          <li v-if="issues.length === 0" class="msd-hint">{{ t("milestone.noCachedIssues") }}</li>
        </ul>
      </section>

      <section class="msd-section">
        <h3 class="msd-section-title">{{ t("milestone.detail.commits", { n: commits.length }) }}</h3>
        <p v-if="commitsLoading" class="msd-hint">{{ t("list.loading") }}</p>
        <p v-else-if="commits.length === 0" class="msd-hint">{{ t("milestone.detail.noCommits") }}</p>
        <ul v-else class="msd-commit-list">
          <li
            v-for="commit in commits"
            :key="commit.oid"
            class="msd-commit"
            role="button"
            tabindex="0"
            :aria-expanded="expandedOid === commit.oid"
            @click="toggleCommit(commit.oid)"
            @keydown.enter.prevent="toggleCommit(commit.oid)"
          >
            <div v-if="expandedOid === commit.oid" class="msd-commit-detail">
              <span class="msd-hash">{{ commit.oid.slice(0, 10) }}</span>
              <span class="msd-parents">{{ t("gitHistory.parents", { n: commit.parents.length }) }}</span>
            </div>
            <span class="msd-commit-message">{{ commit.message.split("\n")[0] }}</span>
            <span class="msd-commit-meta">{{ commit.author ?? "…" }} · {{ dateOf(commit.committedAtUnix) }}</span>
          </li>
        </ul>
      </section>

      <footer class="msd-footer">
        <span class="msd-foot-progress">{{ t("milestone.progressTitle", { done, total }) }}</span>
        <span class="msd-spacer"></span>
        <button
          v-if="meta?.htmlUrl && openBtnLabel"
          class="msd-online"
          @click="openOnline(meta?.htmlUrl)"
        >
          {{ openBtnLabel }}
        </button>
      </footer>
    </template>

    <p v-else-if="error" class="msd-hint err">{{ error }}</p>
    <p v-else class="msd-hint">{{ t("milestone.detail.missing") }}</p>
  </div>
</template>

<style scoped>
.msd-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
}
.msd-head {
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.msd-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
}
.msd-title-row .msd-spacer {
  flex: 1;
}
.msd-state {
  flex: none;
  font-size: var(--font-sm);
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 10px;
}
.msd-state.open {
  color: var(--success);
  background: var(--success-soft);
}
.msd-state.closed {
  color: var(--merged);
  background: var(--merged-soft);
}
.msd-spacer {
  flex: 1;
}
/* 管理按钮（关闭/重开、编辑）——与 Issue 详情 state-action 同规格 */
.msd-action {
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
.msd-action:first-of-type {
  margin-left: auto;
}
.msd-action:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.msd-action.armed:not(:disabled) {
  border-color: var(--danger);
  background: var(--danger-soft);
  color: var(--danger);
}
.msd-action:disabled {
  opacity: 0.5;
  cursor: default;
}
.msd-title {
  margin: 8px 0;
  font-size: var(--font-xl);
  font-weight: 600;
  color: var(--text);
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.msd-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 0;
  margin-bottom: 8px;
}
.msd-due {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.msd-due.overdue {
  color: var(--danger);
  font-weight: 600;
}
.msd-progress {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.msd-track {
  width: 120px;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-hover);
  overflow: hidden;
}
.msd-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--success);
}
.msd-desc {
  margin-top: 8px;
}
/* ---- 编辑态 ---- */
.msd-edit-title {
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
.msd-edit-title:focus {
  border-color: var(--accent);
}
.msd-edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.msd-edit-label {
  flex: none;
  font-size: var(--font-md);
  color: var(--text-dim);
}
.msd-edit-date {
  font-size: var(--font-md);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  outline: none;
}
.msd-edit-date:focus {
  border-color: var(--accent);
}
.msd-edit-error {
  margin: 8px 0 0;
  padding: 7px 10px;
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
  word-break: break-all;
}
.msd-edit-desc {
  box-sizing: border-box;
  width: 100%;
  margin-top: 8px;
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
.msd-edit-desc:focus {
  border-color: var(--accent);
}
.msd-edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.msd-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  height: 26px;
  padding: 0 14px;
  border-radius: 6px;
  cursor: pointer;
}
.msd-btn.primary {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.msd-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.msd-section {
  margin-top: 12px;
  flex: none;
}
.msd-section-title {
  margin: 0 0 4px;
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--text);
}
.msd-issues {
  margin: 0;
  padding: 0;
  list-style: none;
}
.msd-commit-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.msd-commit {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  list-style: none;
}
.msd-commit:hover {
  background: var(--bg-hover);
}
.msd-commit-detail {
  display: flex;
  align-items: center;
  gap: 8px;
}
.msd-hash {
  font-family: ui-monospace, monospace;
  font-size: var(--font-sm);
  color: var(--accent);
}
.msd-parents {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.msd-commit-message {
  font-size: var(--font-base);
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.msd-commit-meta {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.msd-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.msd-foot-progress {
  font-size: var(--font-md);
  color: var(--text-dim);
}
.msd-online {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--accent);
  font-size: var(--font-md);
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.msd-online:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.msd-hint {
  font-size: var(--font-sm);
  color: var(--text-dim);
  padding: 4px 0;
}
.msd-hint.err {
  color: var(--danger);
}
</style>
