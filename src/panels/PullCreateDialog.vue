<script setup lang="ts">
/**
 * PR 创建对话框（远端来源，形制对齐 GitHub compare 页）：head/base 从
 * 远端分支清单选择；选定后本地 git 解析 base..head 提交清单（创建前
 * 的 review 仪式，见知识库《本地Issue与本地分支Review》Q3），标题/描述
 * 按 GitHub 惯例预填（最旧提交主题做标题，其余按序列表做描述）；描述
 * 支持撰写/预览。创建走 Source 写穿透——成功后列表刷新并选中新 PR。
 */
import { computed, ref, watch } from "vue";
import { api, isTauri } from "../api";
import type { GitCommitRow } from "../types";
import { useI18n } from "../i18n";
import { translateError } from "../gh-errors";
import MarkdownView from "../components/MarkdownView.vue";
import DropdownMenu from "../components/DropdownMenu.vue";

const props = defineProps<{ open: boolean; repoPath: string }>();
const emit = defineEmits<{ close: []; created: [number: number] }>();

const { t } = useI18n();

const heads = ref<string[]>([]);
const bases = ref<string[]>([]);
const head = ref("");
const base = ref("");
const title = ref("");
const body = ref("");
const descTab = ref<"write" | "preview">("write");
const commits = ref<GitCommitRow[] | null>(null); // null = 不可知（如远端未抓取），静默不渲染
const commitsLoading = ref(false);
const loading = ref(false);
const creating = ref(false);
const error = ref<string | null>(null);

const headChoices = computed(() => heads.value.filter((n) => n !== base.value));
const baseOptions = computed(() => bases.value.map((n) => ({ value: n, label: n })));
const headOptions = computed(() => headChoices.value.map((n) => ({ value: n, label: n })));

// base 撞上 head 时自动把 head 挪到下一个可用分支
watch(base, (n) => {
  if (head.value === n) head.value = headChoices.value[0] ?? "";
});

const canSubmit = computed(() => head.value && base.value && title.value.trim() && !creating.value);

async function loadBranches() {
  if (!isTauri() || !props.repoPath) return;
  loading.value = true;
  error.value = null;
  try {
    const names = await api.remoteBranchList(props.repoPath);
    heads.value = names;
    bases.value = names;
    base.value = names.find((n) => n === "main") ?? names.find((n) => n === "master") ?? names[0] ?? "";
  } catch (e) {
    error.value = translateError(String(e));
  } finally {
    loading.value = false;
  }
}

/** 创建前提交预览：本地克隆解析 base..head；失败静默（清单是增强信息）。 */
async function loadCommits() {
  if (!isTauri() || !props.repoPath || !base.value || !head.value || base.value === head.value) {
    commits.value = [];
    return;
  }
  const baseAt = base.value;
  const headAt = head.value;
  commitsLoading.value = true;
  try {
    const rows = await api.prCommitsBetween(props.repoPath, baseAt, headAt);
    if (base.value !== baseAt || head.value !== headAt) return; // 已切换分支，旧结果丢弃
    commits.value = rows;
    prefillFromCommits(rows);
  } catch {
    // 不可知（如远端分支未抓取到本地）保持 null，静默不渲染
  } finally {
    commitsLoading.value = false;
  }
}

/** GitHub compare 页惯例：最旧提交主题预填标题，其余提交按序做描述。 */
function prefillFromCommits(rows: GitCommitRow[]) {
  if (rows.length === 0) return;
  if (!title.value.trim()) title.value = rows[rows.length - 1].message;
  if (!body.value.trim() && rows.length > 1) {
    body.value = rows
      .slice(0, -1)
      .reverse()
      .map((c) => `- ${c.message}`)
      .join("\n");
  }
}

async function submit() {
  if (!canSubmit.value) return;
  creating.value = true;
  error.value = null;
  try {
    const created = await api.createPull(props.repoPath, head.value, base.value, title.value.trim(), body.value || undefined);
    emit("created", created.number);
    reset();
  } catch (e) {
    error.value = translateError(String(e));
  } finally {
    creating.value = false;
  }
}

function reset() {
  title.value = "";
  body.value = "";
  descTab.value = "write";
  head.value = "";
  base.value = "";
  commits.value = null;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && !creating.value) emit("close");
}

function dateOf(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      reset();
      error.value = null;
      void loadBranches();
    }
  },
);

watch([base, head], () => void loadCommits());

</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="pc-overlay" @click.self="!creating && emit('close')" @keydown="onKeydown">
      <div class="pc-card" role="dialog" :aria-label="t('pull.createBtn')">
        <div class="pc-head">
          <h3 class="pc-title">{{ t("pull.createTitle") }}</h3>
          <button v-if="!creating" class="pc-close" @click="emit('close')">✕</button>
        </div>

        <p v-if="error" class="pc-error">{{ error }}</p>

        <div class="pc-ref-row">
          <span class="pc-ref-label">{{ t("branchReview.base") }}</span>
          <DropdownMenu class="pc-ref-dd" :options="baseOptions" v-model="base" placeholder="…" />
        </div>

        <div class="pc-ref-row">
          <span class="pc-ref-label">{{ t("pull.headLabel") }}</span>
          <DropdownMenu class="pc-ref-dd" :options="headOptions" v-model="head" placeholder="…" />
        </div>

        <div v-if="commitsLoading" class="pc-commits-hint">{{ t("list.loading") }}</div>
        <div v-else-if="commits && commits.length === 0" class="pc-commits-hint">
          {{ t("pull.noDiff", { head: head, base: base }) }}
        </div>
        <div v-else-if="commits && commits.length > 0" class="pc-commits">
          <h4 class="pc-commits-title">{{ t("pull.commitsTitle", { n: commits.length }) }}</h4>
          <ul class="pc-commit-list">
            <li v-for="c in commits" :key="c.oid" class="pc-commit-row">
              <span class="pc-commit-msg">{{ c.message }}</span>
              <span class="pc-commit-meta">{{ c.author ?? "…" }} · {{ dateOf(c.committedAtUnix) }}</span>
            </li>
          </ul>
        </div>

        <input
          v-model="title"
          class="pc-input"
          :placeholder="t('pull.titlePh')"
          spellcheck="false"
        />
        <div class="pc-tabs">
          <button
            class="pc-tab"
            :class="{ active: descTab === 'write' }"
            @click="descTab = 'write'"
          >{{ t("issue.tabWrite") }}</button>
          <button
            class="pc-tab"
            :class="{ active: descTab === 'preview' }"
            @click="descTab = 'preview'"
          >{{ t("issue.tabPreview") }}</button>
        </div>
        <textarea
          v-if="descTab === 'write'"
          v-model="body"
          class="pc-textarea"
          :placeholder="t('issue.bodyPlaceholder')"
          rows="4"
        />
        <div v-else class="pc-preview">
          <MarkdownView v-if="body.trim()" :source="body" />
          <p v-else class="pc-preview-empty">{{ t("common.noBody") }}</p>
        </div>

        <div class="pc-actions">
          <button class="pc-btn" :disabled="creating" @click="emit('close')">{{ t("conn.cancel") }}</button>
          <button class="pc-btn primary" :disabled="!canSubmit" @click="submit">
            {{ creating ? t("common.syncing") : t("issue.submit") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pc-overlay {
  position: fixed;
  inset: 0;
  z-index: 230;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.pc-card {
  width: 420px;
  max-width: calc(100vw - 40px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 14px 16px;
}
.pc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pc-title {
  margin: 0;
  font-size: var(--font-base);
  color: var(--text);
}
.pc-close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.pc-close:hover {
  color: var(--text);
}
.pc-error {
  margin: 0;
  padding: 7px 10px;
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
  word-break: break-all;
}
/* ---- 分支下拉（统一 DropdownMenu 组件）---- */
.pc-ref-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pc-ref-label {
  width: 72px;
  flex: none;
  font-size: var(--font-md);
  color: var(--text-dim);
}
.pc-ref-dd {
  flex: 1;
}
.pc-input,
.pc-textarea {
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
.pc-input:focus,
.pc-textarea:focus {
  border-color: var(--accent);
}
/* 提交预览（compare 页的灵魂：创建前看一眼要 PR 什么） */
.pc-commits-hint {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.pc-commits {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pc-commits-title {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--text);
}
.pc-commit-list {
  max-height: 130px;
  overflow-y: auto;
  margin: 0;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  list-style: none;
}
.pc-commit-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
}
.pc-commit-row:hover {
  background: var(--bg-hover);
}
.pc-commit-msg {
  font-size: var(--font-md);
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pc-commit-meta {
  flex: none;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 描述撰写/预览 Tab（与 Issue/里程碑创建对话框同构） */
.pc-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}
.pc-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  padding: 4px 10px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.pc-tab:hover {
  color: var(--text);
}
.pc-tab.active {
  color: var(--text);
  font-weight: 600;
  border-bottom-color: var(--accent);
}
.pc-preview {
  box-sizing: border-box;
  min-height: 70px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  padding: 8px 10px;
}
.pc-preview-empty {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.pc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.pc-btn {
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  height: 26px;
  padding: 0 12px;
  border-radius: 6px;
  cursor: pointer;
}
.pc-btn.primary {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.pc-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
