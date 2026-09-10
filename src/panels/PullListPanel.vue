<script setup lang="ts">
/**
 * Pull-request list panel — registered as "pull.list". Mirrors the issue
 * list with PR-specific meta (head→base, draft, review decision, diffstat).
 */
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import { usePullsStore } from "../stores/pulls";
import type { PullState } from "../types";

defineProps<{ leafId?: string }>();

const store = usePullsStore();
const { pulls, state, loading, error, selectedNumber } = storeToRefs(store);

const states: { value: PullState; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "merged", label: "Merged" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

function timeLabel(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}

const decisionLabel: Record<string, string> = {
  APPROVED: "已批准",
  REVIEW_REQUIRED: "待评审",
  CHANGES_REQUESTED: "需修改",
};
</script>

<template>
  <PanelShell title="Pull Requests" :leaf-id="leafId">
    <template #actions>
      <div class="state-tabs">
        <button
          v-for="s in states"
          :key="s.value"
          class="state-tab"
          :class="{ active: state === s.value }"
          @click="store.setState(s.value)"
        >
          {{ s.label }}
        </button>
      </div>
      <button class="refresh-btn" :disabled="loading" @click="store.refresh()">
        {{ loading ? "同步中…" : "刷新" }}
      </button>
    </template>

    <p v-if="error" class="error-banner">{{ error }}</p>

    <ul class="item-list">
      <li
        v-for="pull in pulls"
        :key="pull.number"
        class="item-row"
        :class="{ active: pull.number === selectedNumber }"
        @click="store.ensureDetail(pull)"
      >
        <div class="item-main">
          <span class="item-title">
            <span v-if="pull.isDraft" class="draft-badge">草稿</span>
            {{ pull.title }}
          </span>
          <span class="item-meta">
            #{{ pull.number }}
            <template v-if="pull.author"> · {{ pull.author }}</template>
            <template v-if="timeLabel(pull.updatedAt)"> · {{ timeLabel(pull.updatedAt) }}</template>
          </span>
          <span class="branch-meta">
            <code>{{ pull.headRef || "?" }}</code>
            <span class="arrow">→</span>
            <code>{{ pull.baseRef || "?" }}</code>
            <span v-if="pull.reviewDecision" class="decision" :class="pull.reviewDecision.toLowerCase()">
              {{ decisionLabel[pull.reviewDecision] ?? pull.reviewDecision }}
            </span>
          </span>
        </div>
        <div class="item-tags">
          <span
            v-for="label in pull.labels.slice(0, 3)"
            :key="label"
            class="chip"
          >{{ label }}</span>
        </div>
      </li>
      <li v-if="!loading && pulls.length === 0" class="empty-row">
        暂无数据，点击「刷新」从 GitHub 拉取
      </li>
    </ul>
  </PanelShell>
</template>

<style scoped>
.state-tabs {
  display: flex;
  gap: 2px;
}
.state-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  padding: 3px 9px;
  border-radius: 5px;
  cursor: pointer;
}
.state-tab:hover {
  background: var(--bg-hover);
}
.state-tab.active {
  background: var(--bg-selected);
  color: var(--accent);
  font-weight: 600;
}
.refresh-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: 12px;
  padding: 3px 12px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.refresh-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.refresh-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.error-banner {
  margin: 8px 14px 0;
  padding: 8px 10px;
  font-size: 12px;
  color: #f87171;
  background: rgba(248, 113, 113, 0.08);
  border: 1px solid rgba(248, 113, 113, 0.3);
  border-radius: 6px;
}
.item-list {
  list-style: none;
  margin: 0;
  padding: 4px 6px;
  overflow-y: auto;
  flex: 1;
}
.item-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.item-row:hover {
  background: var(--bg-hover);
}
.item-row.active {
  background: var(--bg-selected);
}
.item-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.item-title {
  font-size: 13px;
  color: var(--text);
  line-height: 1.4;
}
.draft-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
  margin-right: 4px;
  vertical-align: 1px;
}
.item-meta {
  font-size: 11px;
  color: var(--text-dim);
}
.branch-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-dim);
}
.branch-meta code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  background: var(--bg-chip);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.arrow {
  color: var(--text-dim);
}
.decision {
  margin-left: 4px;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 8px;
}
.decision.approved {
  color: #3fb950;
  background: rgba(63, 185, 80, 0.12);
}
.decision.review_required {
  color: #d29922;
  background: rgba(210, 153, 34, 0.12);
}
.decision.changes_requested {
  color: #f87171;
  background: rgba(248, 113, 113, 0.12);
}
.item-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chip {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-chip);
  color: var(--text-dim);
  border: 1px solid var(--border);
}
.empty-row {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  list-style: none;
}
</style>
