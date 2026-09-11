<script setup lang="ts">
import { watch } from "vue";
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import MarkdownView from "../components/MarkdownView.vue";
import CommentsSection from "../components/CommentsSection.vue";
import { stripHtmlComments } from "../components/markdown";
import { useIssuesStore } from "../stores/issues";
import { useRepoStore } from "../stores/repo";
import { useI18n } from "../i18n";
import { useCloseReopen } from "./close-reopen";

defineProps<{ leafId?: string; panelType?: string }>();

const issues = useIssuesStore();
const repo = useRepoStore();
const { selected } = storeToRefs(issues);
const { t } = useI18n();

const {
  armed: closeArmed,
  working: closeWorking,
  close: closeClick,
  reopen: reopenClick,
} = useCloseReopen(async (closed) => {
  if (issues.selected) await issues.setClosed(issues.selected, closed);
});

// Load the conversation whenever the selection changes.
watch(
  () => issues.selected?.number,
  (number) => {
    if (number) void issues.loadComments(number);
    else issues.clearComments();
  },
  { immediate: true },
);

function onSubmitComment(body: string) {
  if (issues.selected) void issues.addComment(issues.selected.number, body);
}

function hasVisibleBody(body?: string | null): boolean {
  return !!body && stripHtmlComments(body).trim().length > 0;
}

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
    <template v-if="selected">
      <header class="detail-header">
        <div class="detail-title-row">
          <span class="detail-number">#{{ selected.number }}</span>
          <span class="detail-state" :class="selected.state.toLowerCase()">{{ selected.state }}</span>
          <button
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
        <div class="detail-tags">
          <span v-for="label in selected.labels" :key="label" class="detail-label">{{ label }}</span>
        </div>
      </header>

      <div class="detail-body">
        <MarkdownView v-if="hasVisibleBody(selected.body)" :source="selected.body" />
        <p v-else class="detail-nobody">{{ t("common.noBody") }}</p>

        <CommentsSection
          :comments="issues.comments"
          :loading="issues.commentsLoading"
          :submitting="issues.commentSubmitting"
          @submit="onSubmitComment"
        />
      </div>

      <footer class="detail-footer">
        <div class="detail-people">
          <template v-if="selected.author">{{ t("common.author", { name: selected.author }) }}</template>
          <template v-if="selected.assignees.length">
            　·　{{ t("common.assignees", { name: selected.assignees.join(", ") }) }}
          </template>
        </div>
        <button v-if="selected.url" class="open-github" @click="openUrl(selected.url)">
          {{ t("common.openInGithub") }}
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
  gap: 10px;
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
  color: var(--merged);
  background: var(--merged-soft);
}
.detail-title {
  margin: 8px 0 8px;
  font-size: 17px;
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
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 12px;
  background: var(--bg-chip);
  color: var(--text-dim);
  border: 1px solid var(--border);
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
