<script setup lang="ts">
/**
 * Application status bar (VS Code style): quiet 24px strip pinned to the
 * window bottom. Left = repository context, right = sync/health/version —
 * the same three-segment split as QHiveFrame's QHFAppStatusBar (prompts /
 * stats / version), with segments as hover-highlighted "cells".
 *
 * Visibility is owned by the settings store (View menu / settings panel);
 * the host renders this component conditionally.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useRepoStore } from "../stores/repo";
import { useIssuesStore } from "../stores/issues";
import { usePullsStore } from "../stores/pulls";
import { useI18n } from "../i18n";
import { APP_VERSION } from "../app-info";

const props = defineProps<{ workspace: string }>();

const repo = useRepoStore();
const issues = useIssuesStore();
const pulls = usePullsStore();
const { t, locale, locales, cycleLocale } = useI18n();
const { current, origin, ghAvailable } = storeToRefs(repo);

/** Self-name of the active locale (中文 / English / …) — scales to any N. */
const localeLabel = computed(
  () => locales.find((l) => l.value === locale.value)?.label ?? locale.value,
);

const repoName = computed(() => {
  if (!current.value) return null;
  const parts = current.value.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? current.value;
});

// Sync time of the active workspace; the settings workspace has none.
const syncedAt = computed(() => {
  if (props.workspace === "issues") return issues.lastSyncedAt;
  if (props.workspace === "pulls") return pulls.lastSyncedAt;
  return null;
});
</script>

<template>
  <footer class="statusbar">
    <div class="status-left">
      <button
        class="status-cell repo-cell"
        :title="current ?? t('app.repoPick')"
        @click="repo.pick()"
      >
        <span class="cell-mark">⬡</span>
        {{ repoName ?? t("statusbar.noRepo") }}
      </button>
      <span v-if="origin" class="status-cell" :title="origin">{{ origin }}</span>
      <span class="status-cell source-cell">GitHub</span>
    </div>

    <div class="status-right">
      <button
        class="status-cell lang-cell"
        :title="t('lang.switch')"
        @click="cycleLocale()"
      >
        {{ localeLabel }}
      </button>
      <span v-if="syncedAt" class="status-cell" :title="t('statusbar.syncedAt', { time: syncedAt })">
        ⟳ {{ syncedAt }}
      </span>
      <span
        v-if="ghAvailable !== null"
        class="status-cell gh-cell"
        :class="{ ok: ghAvailable, missing: !ghAvailable }"
        :title="ghAvailable ? t('statusbar.ghOk') : t('statusbar.ghMissing')"
      >
        ● gh
      </span>
      <span class="status-cell version-cell">HiveTask v{{ APP_VERSION }}</span>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 24px;
  background: var(--bg-app);
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-dim);
  user-select: none;
}
.status-left,
.status-right {
  display: flex;
  align-items: stretch;
  height: 100%;
  min-width: 0;
}
/* Cells are full-height so hover highlight reads like VS Code segments. */
.status-cell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  white-space: nowrap;
}
.status-left .status-cell:first-child {
  padding-left: 10px;
}
.status-right .status-cell:last-child {
  padding-right: 10px;
}
button.status-cell {
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.status-cell:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.cell-mark {
  color: var(--accent);
  font-size: 11px;
}
.repo-cell {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.source-cell {
  color: var(--accent);
}
.gh-cell.ok {
  color: var(--success);
}
.gh-cell.missing {
  color: var(--danger);
}
.version-cell {
  color: var(--text-dim);
  opacity: 0.8;
}
</style>
