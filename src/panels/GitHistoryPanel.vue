<script setup lang="ts">
/**
 * Git history panel — commit graph across all local + remote tips.
 *
 * Data comes from git2 (src-tauri/src/git.rs); lane GEOMETRY from
 * @web-git-graph's exported layoutGitGraph() (nodes/segments/lanes), while
 * all presentation is ours: i18n column headers, drag-resizable date and
 * author columns, a collapsible branch strip, and a bottom commit-details
 * drawer with a fixed-width graph column that never gets squeezed.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import PanelShell from "../workbench/PanelShell.vue";
import { useRepoStore } from "../stores/repo";
import { api, isTauri } from "../api";
import { useI18n } from "../i18n";
import { translateError } from "../gh-errors";
import { layoutGitGraph } from "@web-git-graph/web";
import type { GitBranchRow, GitCommitRow, GitHistoryPage } from "../types";

defineProps<{ leafId?: string; panelType?: string }>();

const repo = useRepoStore();
const { current } = storeToRefs(repo);
const { t } = useI18n();

const history = ref<GitHistoryPage | null>(null);
const branches = ref<GitBranchRow[]>([]);
const loading = ref(false);
const fetching = ref(false);
const error = ref<string | null>(null);
/** null = walk every tip; a branch name filters the graph to it. */
const selectedRef = ref<string | null>(null);
/** Inline-expanded commit row (details shown inside the row). */
const expandedOid = ref<string | null>(null);

async function load() {
  if (!current.value || !isTauri()) return;
  loading.value = true;
  error.value = null;
  try {
    const [historyPage, branchRows] = await Promise.all([
      api.gitHistory(current.value),
      api.gitBranches(current.value),
    ]);
    history.value = historyPage;
    branches.value = branchRows.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  } catch (e) {
    error.value = translateError(String(e));
  } finally {
    loading.value = false;
  }
}

async function fetchAll() {
  if (!current.value || fetching.value) return;
  fetching.value = true;
  try {
    await api.gitFetch(current.value);
    await load();
  } catch (e) {
    error.value = translateError(String(e));
  } finally {
    fetching.value = false;
  }
}

watch(current, () => void load(), { immediate: true });

// ---- Lane geometry (borrowed algorithm) → our SVG ----

const LANE_W = 14;
const ROW_H = 30;
const LANE_COLORS = ["#5b8def", "#a371f7", "#3fb950", "#d29922", "#f87171", "#9aa0a8"];

const graph = computed(() => {
  if (!history.value || history.value.commits.length === 0) return null;
  const dtos = history.value.commits.map((c) => ({
    kind: "commit" as const,
    oid: c.oid,
    parents: c.parents,
    message: c.message,
  }));
  const layout = layoutGitGraph(dtos);
  const width = Math.max(layout.laneCount, 1) * LANE_W + 8;
  return { layout, color: (index: number) => LANE_COLORS[index % LANE_COLORS.length], width };
});

/** Details open inside the expanded row; everything below shifts down so
 * lanes stay glued to their nodes (the component's `anchor` contract). */
const DETAILS_H = 64;
const expandedIndex = computed(() =>
  expandedOid.value ? history.value?.commits.findIndex((c) => c.oid === expandedOid.value) ?? -1 : -1,
);
function rowOffset(index: number): number {
  return index * ROW_H + (expandedIndex.value >= 0 && index > expandedIndex.value ? DETAILS_H : 0);
}
const totalHeight = computed(() => {
  const rows = history.value?.commits.length ?? 0;
  return rows * ROW_H + (expandedIndex.value >= 0 ? DETAILS_H : 0);
});

function nodeX(lane: number): number {
  return lane * LANE_W + LANE_W / 2 + 4;
}
function nodeY(row: number): number {
  return rowOffset(row) + ROW_H / 2;
}
function segmentPath(segment: { from: { lane: number; row: number }; to: { lane: number; row: number } }): string {
  const x1 = nodeX(segment.from.lane);
  const y1 = nodeY(segment.from.row);
  const x2 = nodeX(segment.to.lane);
  const y2 = nodeY(segment.to.row);
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

// ---- Branch strip (ours: i18n, collapsible, defaults collapsed) ----

const branchesOpen = ref(false);
const currentBranch = computed(() => branches.value.find((b) => b.isCurrent));

// ---- Column widths (drag-adjustable) ----

const dateW = ref(90);
const authorW = ref(110);
let dragTarget: "date" | "author" | null = null;
let dragStartX = 0;
let dragStartW = 0;

function startResize(target: "date" | "author", event: PointerEvent) {
  dragTarget = target;
  dragStartX = event.clientX;
  dragStartW = target === "date" ? dateW.value : authorW.value;
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", stopResize);
}
function onResizeMove(event: PointerEvent) {
  if (!dragTarget) return;
  const next = Math.max(56, dragStartW + event.clientX - dragStartX);
  if (dragTarget === "date") dateW.value = next;
  else authorW.value = next;
}
function stopResize() {
  dragTarget = null;
  window.removeEventListener("pointermove", onResizeMove);
  window.removeEventListener("pointerup", stopResize);
}

function pickRef(name: string) {
  selectedRef.value = selectedRef.value === name ? null : name;
}

function selectCommit(commit: GitCommitRow) {
  expandedOid.value = expandedOid.value === commit.oid ? null : commit.oid;
}

function timeLabel(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") expandedOid.value = null;
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template #actions>
      <button
        class="fetch-btn"
        :disabled="fetching || loading"
        :title="t('gitHistory.fetchHint')"
        @click="fetchAll"
      >
        {{ fetching ? t("common.syncing") : t("gitHistory.fetch") }}
      </button>
    </template>

    <p v-if="error" class="error-banner">{{ error }}</p>

    <!-- Branch strip: collapsed by default (current branch + count), expandable. -->
    <div v-if="branches.length" class="branch-strip" :class="{ open: branchesOpen }">
      <span class="strip-label">{{ t("gitHistory.branches") }}</span>
      <template v-if="!branchesOpen">
        <button
          v-if="currentBranch"
          class="branch-chip current"
          @click="branchesOpen = true"
        >
          {{ currentBranch.name }}
          <span
            v-if="currentBranch.ahead || currentBranch.behind"
            class="ab-badge"
            :title="t('gitHistory.aheadBehind', { ahead: currentBranch.ahead, behind: currentBranch.behind })"
          >↑{{ currentBranch.ahead }} ↓{{ currentBranch.behind }}</span>
        </button>
        <span class="strip-more" @click="branchesOpen = true">
          {{ t("gitHistory.moreBranches", { n: branches.length - 1 }) }}
        </span>
      </template>
      <template v-else>
        <button
          v-for="branch in branches"
          :key="branch.name"
          class="branch-chip"
          :class="{ current: branch.isCurrent, remote: branch.isRemote, picked: selectedRef === branch.name }"
          :title="t('gitHistory.clickToFilter')"
          @click="pickRef(branch.name)"
        >
          {{ branch.name }}
          <span
            v-if="!branch.isRemote && (branch.ahead || branch.behind)"
            class="ab-badge"
            :title="t('gitHistory.aheadBehind', { ahead: branch.ahead, behind: branch.behind })"
          >↑{{ branch.ahead }} ↓{{ branch.behind }}</span>
        </button>
        <button class="strip-collapse" @click="branchesOpen = false">{{ t("gitHistory.collapse") }}</button>
      </template>
    </div>

    <!-- Column headers: i18n labels, drag-resizable date/author columns. -->
    <div class="col-headers">
      <span class="col-graph">{{ t("gitHistory.colGraph") }}</span>
      <span class="col-date" :style="{ width: dateW + 'px' }">{{ t("gitHistory.colDate") }}</span>
      <span class="col-resize" @pointerdown="startResize('date', $event)"></span>
      <span class="col-author" :style="{ width: authorW + 'px' }">{{ t("gitHistory.colAuthor") }}</span>
      <span class="col-resize" @pointerdown="startResize('author', $event)"></span>
      <span class="col-message">{{ t("gitHistory.colCommit") }}</span>
    </div>

    <div class="graph-wrap">
      <p v-if="loading" class="graph-note">{{ t("common.loadingFull") }}</p>
      <p v-else-if="error" class="graph-note">{{ error }}</p>
      <p v-else-if="!graph" class="graph-note">{{ t("gitHistory.noCommits") }}</p>
      <div
        v-else-if="graph"
        class="log-scroll"
        :style="{ width: graph.width + dateW + authorW + 'px', height: totalHeight + 'px' }"
      >
        <!-- Lane geometry layer: absolute SVG behind the rows. -->
        <svg class="lanes" :width="graph.width" :height="totalHeight">
          <path
            v-for="(segment, i) in graph.layout.segments"
            :key="'s' + i"
            :d="segmentPath(segment)"
            :stroke="graph.color(segment.colour)"
            stroke-width="1.5"
            fill="none"
          />
          <circle
            v-for="node in graph.layout.nodes"
            :key="node.oid"
            :cx="nodeX(node.lane)"
            :cy="nodeY(node.row)"
            r="4"
            :fill="graph.color(node.colour)"
          />
        </svg>
        <!-- Row layer: aligned with ROW_H, refs chips inline with message. -->
        <div class="rows" :style="{ left: graph.width + 'px' }">
          <div
            v-for="(commit, index) in history!.commits"
            :key="commit.oid"
            class="commit-row"
            role="button"
            tabindex="0"
            :aria-expanded="expandedOid === commit.oid"
            :class="{ expanded: expandedOid === commit.oid }"
            :style="{ top: rowOffset(index) + 'px' }"
            @click="selectCommit(commit)"
            @keydown.enter.prevent="selectCommit(commit)"
          >
            <div v-if="expandedOid === commit.oid" class="row-details">
              <div class="detail-line">
                <span class="detail-hash">{{ commit.oid.slice(0, 10) }}</span>
                <span class="detail-parents">{{ t("gitHistory.parents", { n: commit.parents.length }) }}</span>
                <span class="detail-parent-oids">{{ commit.parents.map((p) => p.slice(0, 7)).join("  ") }}</span>
              </div>
              <p class="detail-message">{{ commit.message }}</p>
            </div>
            <span class="cell-date" :style="{ width: dateW + 'px' }">{{ timeLabel(commit.committedAtUnix) }}</span>
            <span class="cell-author" :style="{ width: authorW + 'px' }">{{ commit.author ?? "…" }}</span>
            <span class="cell-message">
              <span
                v-for="refRow in history!.refs.filter((r) => r.target === commit.oid)"
                :key="refRow.name"
                class="ref-chip"
                :class="refRow.kind"
              >{{ refRow.name }}</span>
              {{ commit.message }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </PanelShell>
</template>

<style scoped>
.fetch-btn {
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
.fetch-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.fetch-btn:disabled {
  opacity: 0.5;
  cursor: default;
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

/* Branch strip — one line collapsed, wraps when open. */
.branch-strip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}
.branch-strip.open {
  flex-wrap: wrap;
}
.strip-label {
  font-size: var(--font-sm);
  color: var(--text-dim);
  flex: none;
}
.strip-more {
  font-size: var(--font-sm);
  color: var(--accent);
  cursor: pointer;
  flex: none;
}
.strip-collapse {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-sm);
  cursor: pointer;
  padding: 0 4px;
}
.strip-collapse:hover {
  color: var(--text);
}
.branch-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text-dim);
  font-size: var(--font-sm);
  height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  cursor: pointer;
  white-space: nowrap;
}
.branch-chip:hover {
  color: var(--text);
}
.branch-chip.current {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.branch-chip.remote {
  border-style: dashed;
}
.branch-chip.picked {
  background: var(--bg-selected);
  color: var(--accent);
}
.ab-badge {
  font-size: var(--font-xs);
  color: var(--warning);
}

/* Column headers — label row matching the resizable columns. */
.col-headers {
  flex: none;
  display: flex;
  align-items: center;
  height: 24px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.col-graph {
  width: 62px;
  flex: none;
}
.col-date,
.col-author {
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
}
.col-resize {
  width: 5px;
  height: 100%;
  cursor: col-resize;
  flex: none;
}
.col-resize:hover {
  background: var(--bg-hover);
}
.col-message {
  flex: 1;
  overflow: hidden;
}

/* Log: SVG lanes absolutely behind, rows offset by the graph width. */
.graph-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
}
.graph-note {
  margin: auto;
  color: var(--text-dim);
  font-size: var(--font-md);
}
.log-scroll {
  position: relative;
  min-width: 100%;
}
.commit-row {
  position: absolute;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  height: 30px;
  gap: 0 8px;
  cursor: pointer;
  white-space: nowrap;
}
.commit-row.expanded {
  flex-wrap: wrap;
  height: auto;
  align-items: flex-start;
  background: var(--bg-app);
  border-bottom: 1px solid var(--border);
  cursor: default;
}
.cell-message {
  flex: 1 1 auto;
  min-width: 0;
}
.row-details {
  width: 100%;
  padding: 8px 14px 10px 14px;
}
.detail-line {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.detail-hash {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--accent);
}
.detail-parent-oids {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.detail-message {
  margin: 5px 0 0;
  font-size: var(--font-md);
  color: var(--text);
}
.lanes {
  position: absolute;
  top: 0;
  left: 0;
}
.rows {
  position: absolute;
  top: 0;
  right: 0;
}
.commit-row:hover {
  background: var(--bg-hover);
}
.cell-date,
.cell-author {
  flex: none;
  font-size: var(--font-sm);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
}
.cell-message {
  font-size: var(--font-md);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 14px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.ref-chip {
  flex: none;
  font-size: var(--font-xs);
  padding: 0 6px;
  border-radius: 8px;
  border: 1px solid var(--border);
  color: var(--text-dim);
  background: var(--bg-chip);
}
.ref-chip.current {
  border-color: var(--accent);
  color: var(--accent);
}
.ref-chip.head {
  border-color: var(--merged);
  color: var(--merged);
}

/* Details view (direction B) — replaces the log and takes its full flex. */
.details-view {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px;
  background: var(--bg-app);
}
.detail-line {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.detail-hash {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--accent);
}
.detail-parent-oids {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.detail-close {
  margin-left: auto;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  cursor: pointer;
  font-size: var(--font-sm);
  height: 22px;
  padding: 0 10px;
  border-radius: 5px;
}
.detail-close:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.detail-close:hover {
  color: var(--text);
}
.detail-message {
  margin: 5px 0 0;
  font-size: var(--font-md);
  color: var(--text);
}
</style>
