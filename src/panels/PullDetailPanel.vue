<script setup lang="ts">
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import MarkdownView from "../components/MarkdownView.vue";
import { stripHtmlComments } from "../components/markdown";
import { usePullsStore } from "../stores/pulls";
import { useRepoStore } from "../stores/repo";

const pulls = usePullsStore();
const repo = useRepoStore();
const { selected, detailLoading } = storeToRefs(pulls);

function hasVisibleBody(body?: string | null): boolean {
  return !!body && stripHtmlComments(body).trim().length > 0;
}

function openUrl(url?: string | null) {
  if (!url) return;
  if ("__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));
  } else {
    window.open(url, "_blank", "noopener");
  }
}

const decisionLabel: Record<string, string> = {
  APPROVED: "已批准",
  REVIEW_REQUIRED: "待评审",
  CHANGES_REQUESTED: "需修改",
};
</script>

<template>
  <PanelShell>
    <template v-if="selected">
      <header class="detail-header">
        <div class="detail-title-row">
          <span class="detail-number">#{{ selected.number }}</span>
          <span
            v-if="selected.isDraft"
            class="detail-state draft"
          >草稿</span>
          <span
            class="detail-state"
            :class="selected.state.toLowerCase()"
          >{{ selected.state === "MERGED" ? "已合并" : selected.state }}</span>
          <span
            v-if="selected.reviewDecision"
            class="detail-decision"
            :class="selected.reviewDecision.toLowerCase()"
          >
            {{ decisionLabel[selected.reviewDecision] ?? selected.reviewDecision }}
          </span>
        </div>
        <h2 class="detail-title">{{ selected.title }}</h2>

        <div class="detail-branch">
          <code>{{ selected.headRef || "?" }}</code>
          <span class="arrow">→</span>
          <code>{{ selected.baseRef || "?" }}</code>
        </div>

        <div class="detail-tags">
          <span v-for="label in selected.labels" :key="label" class="detail-label">{{ label }}</span>
        </div>

        <div class="detail-stats">
          <span class="stat additions">+{{ selected.additions }}</span>
          <span class="stat deletions">−{{ selected.deletions }}</span>
          <span class="stat">{{ selected.commits }} commits</span>
          <span class="stat">{{ selected.comments }} 评论</span>
        </div>
      </header>

      <div class="detail-body">
        <MarkdownView v-if="hasVisibleBody(selected.body)" :source="selected.body" />
        <p v-else-if="detailLoading" class="detail-nobody">正在从 GitHub 加载完整信息…</p>
        <p v-else class="detail-nobody">（无描述内容）</p>
      </div>

      <footer class="detail-footer">
        <div class="detail-people">
          <template v-if="selected.author">作者：{{ selected.author }}</template>
          <template v-if="selected.assignees.length">
            　·　负责人：{{ selected.assignees.join(", ") }}
          </template>
          <template v-if="selected.reviewers.length">
            　·　评审：{{ selected.reviewers.join(", ") }}
          </template>
        </div>
        <button v-if="selected.url" class="open-github" @click="openUrl(selected.url)">
          在 GitHub 打开
        </button>
      </footer>
    </template>

    <div v-else class="detail-empty">
      <p v-if="repo.current">从左侧选择一个 Pull Request 查看详情</p>
      <p v-else>先选择一个本地 Git 仓库，然后刷新 Pull Requests</p>
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
  gap: 10px;
  flex-wrap: wrap;
}
.detail-number {
  font-size: 13px;
  color: var(--text-dim);
}
.detail-state {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 10px;
}
.detail-state.open {
  color: #3fb950;
  background: rgba(63, 185, 80, 0.12);
}
.detail-state.closed {
  color: #f87171;
  background: rgba(248, 113, 113, 0.12);
}
.detail-state.merged {
  color: #a371f7;
  background: rgba(163, 113, 247, 0.12);
}
.detail-state.draft {
  color: var(--text-dim);
  background: var(--bg-chip);
  border: 1px solid var(--border);
}
.detail-decision {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 10px;
}
.detail-decision.approved {
  color: #3fb950;
  background: rgba(63, 185, 80, 0.12);
}
.detail-decision.review_required {
  color: #d29922;
  background: rgba(210, 153, 34, 0.12);
}
.detail-decision.changes_requested {
  color: #f87171;
  background: rgba(248, 113, 113, 0.12);
}
.detail-title {
  margin: 8px 0;
  font-size: 17px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.4;
}
.detail-branch {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-dim);
}
.detail-branch code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  background: var(--bg-chip);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 7px;
}
.detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.detail-label {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 12px;
  background: var(--bg-chip);
  color: var(--text-dim);
  border: 1px solid var(--border);
}
.detail-stats {
  display: flex;
  gap: 12px;
  margin-top: 10px;
  font-size: 12px;
}
.stat.additions {
  color: #3fb950;
}
.stat.deletions {
  color: #f87171;
}
.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
}
.detail-nobody {
  color: var(--text-dim);
  font-size: 13px;
}
.detail-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 20px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-dim);
}
.open-github {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 6px;
  cursor: pointer;
}
.open-github:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}
.detail-empty {
  margin: auto;
  color: var(--text-dim);
  font-size: 13px;
  text-align: center;
}
</style>
