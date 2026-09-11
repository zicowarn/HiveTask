<script setup lang="ts">
/**
 * Conversation section shared by the issue and PR detail panels: the
 * comment list (rendered as Markdown) plus the write form. Purely
 * presentational — the host panel wires its store and forwards `submit`.
 *
 * ⌘/Ctrl+Enter sends; Enter inserts a newline (long-form convention).
 */
import { ref } from "vue";
import MarkdownView from "./MarkdownView.vue";
import { useI18n } from "../i18n";
import type { Comment } from "../types";

const props = defineProps<{
  comments: Comment[];
  loading: boolean;
  submitting: boolean;
}>();
const emit = defineEmits<{ submit: [body: string] }>();

const { t } = useI18n();
const draft = ref("");

function send() {
  const body = draft.value.trim();
  if (!body || props.submitting) return;
  emit("submit", body);
  draft.value = "";
}

function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    send();
  }
}

function timeLabel(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}
</script>

<template>
  <section class="comments">
    <h3 class="comments-title">
      {{ t("comments.title") }}
      <span class="comments-count">{{ comments.filter((c) => !c.pending).length }}</span>
    </h3>

    <p v-if="loading && comments.length === 0" class="comments-empty">
      {{ t("common.loadingFull") }}
    </p>
    <p v-else-if="comments.length === 0" class="comments-empty">{{ t("comments.empty") }}</p>
    <ul v-else class="comment-list">
      <li
        v-for="(comment, index) in comments"
        :key="index"
        class="comment"
        :class="{ pending: comment.pending }"
      >
        <div class="comment-meta">
          <span class="comment-author">{{ comment.author ?? "…" }}</span>
          <span v-if="comment.pending" class="comment-pending">{{ t("comments.sending") }}</span>
          <span v-else class="comment-date">{{ timeLabel(comment.createdAt) }}</span>
        </div>
        <MarkdownView v-if="comment.body" :source="comment.body" />
      </li>
    </ul>

    <div class="comment-form">
      <textarea
        v-model="draft"
        class="comment-input"
        :placeholder="t('comments.placeholder')"
        rows="3"
        @keydown="onKeydown"
      ></textarea>
      <div class="form-actions">
        <button class="comment-send" :disabled="!draft.trim() || submitting" @click="send">
          {{ submitting ? t("comments.sending") : t("comments.send") }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.comments {
  margin-top: 20px;
}
.comments-title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 10px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.comments-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-dim);
  background: var(--bg-chip);
  border-radius: 9px;
  padding: 1px 7px;
}
.comments-empty {
  font-size: 12px;
  color: var(--text-dim);
}
.comment-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.comment {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 7px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--text);
}
.comment.pending {
  opacity: 0.55;
}
.comment-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 5px;
  font-size: 11px;
}
.comment-author {
  font-weight: 600;
  color: var(--text);
}
.comment-date {
  color: var(--text-dim);
}
.comment-pending {
  color: var(--warning);
}
.comment-form {
  margin-top: 12px;
}
.comment-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 64px;
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 8px 10px;
  outline: none;
}
.comment-input:focus {
  border-color: var(--accent);
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
.comment-send {
  border: 1px solid var(--border);
  background: var(--bg-selected);
  color: var(--accent);
  font-size: 12px;
  height: 24px;
  padding: 0 16px;
  border-radius: 6px;
  cursor: pointer;
}
.comment-send:hover:not(:disabled) {
  border-color: var(--accent);
}
.comment-send:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
