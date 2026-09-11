<script setup lang="ts">
/**
 * Application status bar (VS Code style): quiet 24px strip pinned to the
 * window bottom. Left = repository context, right = sync freshness /
 * reachability / gh / language / version — the same three-segment split as
 * QHiveFrame's QHFAppStatusBar (prompts / stats / version), with segments
 * as hover-highlighted "cells".
 *
 * The sync cell reads the per-repo SQLite meta table (migration 005) via
 * the sync-meta store: "last updated" belongs to the data, not the
 * session, so it survives restarts and is tracked per filter bucket.
 * Reachability is tracked passively (gh roundtrip outcomes); clicking the
 * cell runs one user-initiated probe.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useRepoStore } from "../stores/repo";
import { useIssuesStore } from "../stores/issues";
import { usePullsStore } from "../stores/pulls";
import { useSyncMetaStore } from "../stores/sync-meta";
import { netOnline, probeNow } from "../net";
import { useI18n } from "../i18n";
import { APP_VERSION } from "../app-info";

const props = defineProps<{ workspace: string }>();

const repo = useRepoStore();
const issues = useIssuesStore();
const pulls = usePullsStore();
const syncMeta = useSyncMetaStore();
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

// Freshness is per filter bucket: the Open tab being five minutes old says
// nothing about Closed. The settings workspace has no sync of its own.
const syncedAt = computed(() => {
  const key =
    props.workspace === "issues"
      ? `issues:${issues.state}`
      : props.workspace === "pulls"
        ? `pulls:${pulls.state}`
        : null;
  return key ? syncMeta.map[key] ?? null : null;
});

/** "2026-09-11T02:00:00Z" → "5 分钟前" / "2 hours ago", locale-following. */
const syncedLabel = computed(() => {
  if (!syncedAt.value) return "";
  const then = new Date(syncedAt.value).getTime();
  if (Number.isNaN(then)) return syncedAt.value;
  const diffSeconds = Math.round((then - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Infinity],
  ];
  let value = diffSeconds;
  for (const [unit, span] of units) {
    if (Math.abs(value) < span) {
      return new Intl.RelativeTimeFormat(locale.value, { numeric: "auto" }).format(
        value,
        unit,
      );
    }
    value = Math.round(value / span);
  }
  return syncedAt.value;
});

async function probe() {
  await probeNow();
}
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
        v-if="netOnline !== null"
        class="status-cell net-cell"
        :class="{ online: netOnline, offline: !netOnline }"
        :title="netOnline ? t('statusbar.onlineTitle') : t('statusbar.offlineTitle')"
        @click="probe"
      >
        ● {{ netOnline ? t("statusbar.online") : t("statusbar.offline") }}
      </button>
      <span
        v-if="syncedAt"
        class="status-cell"
        :title="t('statusbar.syncedAt', { time: new Date(syncedAt).toLocaleString() })"
      >
        ⟳ {{ syncedLabel }}
      </span>
      <span
        v-if="ghAvailable !== null"
        class="status-cell gh-cell"
        :class="{ ok: ghAvailable, missing: !ghAvailable }"
        :title="ghAvailable ? t('statusbar.ghOk') : t('statusbar.ghMissing')"
      >
        ● gh
      </span>
      <button
        class="status-cell lang-cell"
        :title="t('lang.switch')"
        @click="cycleLocale()"
      >
        {{ localeLabel }}
      </button>
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
.net-cell.online {
  color: var(--success);
}
.net-cell.offline {
  color: var(--warning);
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
