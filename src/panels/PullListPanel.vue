<script setup lang="ts">
/**
 * Pull-request list panel — registered as "pull.list". Mirrors the issue
 * list with PR-specific meta (head→base, draft, review decision, diffstat).
 */
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import BranchReviewList from "./modes/BranchReviewList.vue";
import PullCreateDialog from "./PullCreateDialog.vue";
import { usePullsStore } from "../stores/pulls";
import { useRepoStore } from "../stores/repo";
import { useI18n } from "../i18n";
import { reviewLabel } from "./review-label";
import { stateLabel } from "./state-label";
import type { PullState } from "../types";

defineProps<{ leafId?: string; panelType?: string }>();

const store = usePullsStore();
const { pulls, state, loading, error, selectedNumber } = storeToRefs(store);
const repoStore = useRepoStore();
const { t } = useI18n();

/** 本地仓库 → 分支 review 形态（PR 的本地投影；设计《本地分支Review》）。 */
const isLocal = computed(() => repoStore.platform === "local");

const states: { value: PullState }[] = [
  { value: "open" },
  { value: "merged" },
  { value: "closed" },
  { value: "all" },
];

// PR 创建（远端来源）：创建成功后按编号选中新 PR
const createOpen = ref(false);
async function onCreated(number: number) {
  createOpen.value = false;
  await store.refresh();
  store.select({ number } as never);
}

function timeLabel(iso?: string | null): string {
  return iso ? iso.slice(0, 10) : "";
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <div v-if="!isLocal" class="list-toolbar">
      <div class="state-tabs">
        <button
          v-for="s in states"
          :key="s.value"
          class="state-tab"
          :class="{ active: state === s.value }"
          @click="store.setState(s.value)"
        >
          {{ stateLabel(s.value) }}
        </button>
      </div>
      <span class="toolbar-spacer"></span>
      <button class="refresh-btn" :disabled="loading" @click="store.refresh()">
        {{ loading ? t("common.syncing") : t("common.refresh") }}
      </button>
      <button class="refresh-btn create-btn" @click="createOpen = true">
        {{ t("pull.createBtn") }}
      </button>
    </div>


    <p v-if="error && !isLocal" class="error-banner">{{ error }}</p>

    <BranchReviewList v-if="isLocal" />
    <ul v-else class="item-list">
      <li v-if="loading" class="load-row" :class="{ centered: pulls.length === 0 }">
        <span class="load-spin"></span>{{ t("list.loading") }}
      </li>
      <li
        v-for="pull in pulls"
        :key="pull.number"
        class="item-row"
        :class="{ active: pull.number === selectedNumber }"
        @click="store.ensureDetail(pull)"
      >
        <div class="item-main">
          <span class="item-title">
            <span v-if="pull.isDraft" class="draft-badge">{{ t("common.draft") }}</span>
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
              {{ reviewLabel(pull.reviewDecision) }}
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
        {{ t(repoStore.current ? "common.empty" : "pull.emptyRepo") }}
      </li>
    </ul>
    <PullCreateDialog
      :open="createOpen"
      :repo-path="repoStore.current ?? ''"
      @close="createOpen = false"
      @created="onCreated"
    />
  </PanelShell>
</template>

<style scoped>
.list-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 10px;
}
.toolbar-spacer {
  flex: 1;
}
.state-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.state-tab {
  white-space: nowrap;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  height: 22px;
  padding: 0 9px;
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
  font-size: var(--font-md);
  height: 22px;
  padding: 0 12px;
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
.create-btn {
  color: var(--accent);
  border-color: var(--accent);
}
.error-banner {
  margin: 8px 14px 0;
  padding: 8px 10px;
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
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
/* Row separator: a centered 80%-width hairline, inset from both edges.
   Spacing is symmetric — 8px above (previous row's padding-bottom) vs
   8px below (flex gap 4px + ::before margin 4px). */
.item-row + .item-row {
  padding-top: 0;
}
.item-row + .item-row::before {
  content: "";
  display: block;
  width: 80%;
  height: 1px;
  background: var(--border);
  margin: 0 auto 4px;
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
  font-size: var(--font-base);
  color: var(--text);
  line-height: 1.4;
}
.draft-badge {
  display: inline-block;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
  margin-right: 4px;
  vertical-align: 1px;
}
.item-meta {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.branch-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.branch-meta code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
  padding: 0 6px;
  border-radius: 8px;
}
.decision.approved {
  color: var(--success);
  background: var(--success-soft);
}
.decision.review_required {
  color: var(--warning);
  background: var(--warning-soft);
}
.decision.changes_requested {
  color: var(--danger);
  background: var(--danger-soft);
}
.item-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chip {
  font-size: var(--font-xs);
  padding: 1px 7px;
  border-radius: 10px;
  background: var(--bg-chip);
  color: var(--text-dim);
  border: 1px solid var(--border);
}
.load-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: var(--font-md);
  color: var(--text-dim);
}
.load-row.centered {
  justify-content: center;
  padding: 26px 12px;
}
.load-spin {
  width: 12px;
  height: 12px;
  flex: none;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.empty-row {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-dim);
  font-size: var(--font-md);
  list-style: none;
}
</style>
