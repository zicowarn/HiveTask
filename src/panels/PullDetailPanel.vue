<script setup lang="ts">
import { watch } from "vue";
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import MarkdownView from "../components/MarkdownView.vue";
import CommentsSection from "../components/CommentsSection.vue";
import { stripHtmlComments } from "../components/markdown";
import { usePullsStore } from "../stores/pulls";
import { useRepoStore } from "../stores/repo";
import { useI18n } from "../i18n";
import { openExternalUrl } from "../open-url";
import { reviewLabel } from "./review-label";
import { useCloseReopen } from "./close-reopen";

defineProps<{ leafId?: string; panelType?: string }>();

const pulls = usePullsStore();
const repo = useRepoStore();
const { selected, detailLoading } = storeToRefs(pulls);
const { t } = useI18n();

const {
  armed: closeArmed,
  working: closeWorking,
  close: closeClick,
  reopen: reopenClick,
} = useCloseReopen(async (closed) => {
  if (pulls.selected) await pulls.setClosed(pulls.selected, closed);
});

// Load the conversation whenever the selection changes.
watch(
  () => pulls.selected?.number,
  (number) => {
    if (number) void pulls.loadComments(number);
    else pulls.clearComments();
  },
  { immediate: true },
);

function onSubmitComment(body: string) {
  if (pulls.selected) void pulls.addComment(pulls.selected.number, body);
}

function hasVisibleBody(body?: string | null): boolean {
  return !!body && stripHtmlComments(body).trim().length > 0;
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template v-if="selected">
      <header class="detail-header">
        <div class="detail-title-row">
          <span class="detail-number">#{{ selected.number }}</span>
          <span
            v-if="selected.isDraft"
            class="detail-state draft"
          >{{ t("common.draft") }}</span>
          <span
            class="detail-state"
            :class="selected.state.toLowerCase()"
          >{{ selected.state === "MERGED" ? t("common.merged") : selected.state }}</span>
          <span
            v-if="selected.reviewDecision"
            class="detail-decision"
            :class="selected.reviewDecision.toLowerCase()"
          >
            {{ reviewLabel(selected.reviewDecision) }}
          </span>
          <button
            v-if="selected.state !== 'MERGED'"
            class="state-action"
            :class="{ armed: closeArmed }"
            :disabled="closeWorking"
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
          <span class="stat">{{ t("common.commits", { n: selected.commits }) }}</span>
          <span class="stat">{{ t("common.comments", { n: selected.comments }) }}</span>
        </div>
      </header>

      <div class="detail-body">
        <MarkdownView v-if="hasVisibleBody(selected.body)" :source="selected.body" />
        <p v-else-if="detailLoading" class="detail-nobody">{{ t("common.loadingFull") }}</p>
        <p v-else class="detail-nobody">{{ t("common.noBody") }}</p>

        <CommentsSection
          :comments="pulls.comments"
          :loading="pulls.commentsLoading"
          :submitting="pulls.commentSubmitting"
          @submit="onSubmitComment"
        />
      </div>

      <footer class="detail-footer">
        <div class="detail-people">
          <template v-if="selected.author">{{ t("common.author", { name: selected.author }) }}</template>
          <template v-if="selected.assignees.length">
            　·　{{ t("common.assignees", { name: selected.assignees.join(", ") }) }}
          </template>
          <template v-if="selected.reviewers.length">
            　·　{{ t("common.reviewers", { name: selected.reviewers.join(", ") }) }}
          </template>
        </div>
        <button v-if="selected.url" class="open-github" @click="openExternalUrl(selected.url)">
          {{ t("common.openInGithub") }}
        </button>
      </footer>
    </template>

    <div v-else class="detail-empty">
      <p v-if="repo.current">{{ t("pull.emptySelect") }}</p>
      <p v-else>{{ t("pull.emptyRepo") }}</p>
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
.state-action {
  margin-left: auto;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 11px;
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
.state-action:disabled {
  opacity: 0.5;
  cursor: default;
}
.detail-state {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 10px;
}
.detail-state.open {
  color: var(--success);
  background: var(--success-soft);
}
.detail-state.closed {
  color: var(--danger);
  background: var(--danger-soft);
}
.detail-state.merged {
  color: var(--merged);
  background: var(--merged-soft);
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
  color: var(--success);
  background: var(--success-soft);
}
.detail-decision.review_required {
  color: var(--warning);
  background: var(--warning-soft);
}
.detail-decision.changes_requested {
  color: var(--danger);
  background: var(--danger-soft);
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
  color: var(--success);
}
.stat.deletions {
  color: var(--danger);
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
