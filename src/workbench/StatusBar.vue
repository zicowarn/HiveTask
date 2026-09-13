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
import { useProjectsStore } from "../stores/projects";
import { useSyncMetaStore } from "../stores/sync-meta";
import { netOnline, probeNow } from "../net";
import { useI18n } from "../i18n";
import { APP_VERSION } from "../app-info";
import { shortOrigin } from "../origin";
import EditorIcon from "../components/EditorIcon.vue";

const props = defineProps<{ workspace: string }>();

const repo = useRepoStore();
const issues = useIssuesStore();
const pulls = usePullsStore();
const projectsStore = useProjectsStore();
const syncMeta = useSyncMetaStore();
const { t, locale, localeChoice, locales, cycleLocale } = useI18n();
const { current, origin, ghAvailable } = storeToRefs(repo);

/** Cell shows the raw choice ("跟随系统" when following the OS), else the
 * language's self-name — scales to any N. */
const localeLabel = computed(() => {
  if (localeChoice.value === "system") return t("lang.system");
  return locales.find((l) => l.value === locale.value)?.label ?? locale.value;
});

const repoName = computed(() => {
  if (!current.value) return null;
  const parts = current.value.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? current.value;
});

/** 来源标签与运行时路由同源（repo.platform 来自 repo_info 的
 * resolve_target 链）；无 platform = 本地/未知。 */
const PLATFORM_LABELS: Record<string, string> = {
  github: "GitHub",
  gitee: "Gitee",
  gitea: "Gitea",
  gitlab: "GitLab",
};
const platformLabel = computed(() => {
  const p = repo.platform;
  return p ? (PLATFORM_LABELS[p] ?? p) : t("statusbar.local");
});

/** 项目分布格：选中项目的按列计数（堆叠条 + 总数），点击跳项目工作区。
 * 应用级数据（projects store 启动时已加载）；无选中项目则隐藏。 */
const projBoard = computed(() => projectsStore.selected);
const projDist = computed(() => {
  const field = projectsStore.statusField;
  if (!field) return [];
  return field.options.map((o) => ({
    id: o.id,
    name: o.name,
    color: o.color,
    count: projectsStore.items.filter((i) => i.fieldValues[field.id] === o.id).length,
  }));
});
const projTotal = computed(() => projDist.value.reduce((sum, d) => sum + d.count, 0));
function gotoProjects() {
  projectsStore.navRequest = { workspace: "projects" };
}

// Freshness is per filter bucket on the data workspaces; on other tabs
// (and when the active bucket was never synced) the cell falls back to the
// latest sync across all buckets — a cell that flickers out on tab
// switches reads as "lost" rather than "not applicable".
const syncedAt = computed(() => {
  const bucketKey =
    props.workspace === "issues"
      ? `issues:${issues.state}`
      : props.workspace === "pulls"
        ? `pulls:${pulls.state}`
        : null;
  const times = Object.values(syncMeta.map);
  if (bucketKey) {
    const bucket = syncMeta.map[bucketKey];
    if (bucket) return bucket;
  }
  return times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
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
      <span v-if="origin" class="status-cell" :title="origin">{{ shortOrigin(origin) }}</span>
      <span
        v-if="current"
        class="status-cell source-cell"
        :title="repo.visibility ? t(repo.visibility === 'private' ? 'repo.visibilityPrivate' : 'repo.visibilityPublic') : undefined"
      >
        <EditorIcon
          v-if="repo.visibility"
          :name="repo.visibility === 'private' ? 'lock' : 'unlock'"
        />
        {{ platformLabel }}
      </span>
      <button
        v-if="projBoard && projTotal > 0"
        class="status-cell proj-cell"
        :title="projDist.map((d) => `${d.name} ${d.count}`).join(' · ')"
        @click="gotoProjects"
      >
        <span class="proj-mark">◫</span>
        {{ projBoard.displayName }}
        <span class="proj-bar">
          <span
            v-for="d in projDist"
            :key="d.id"
            class="proj-seg"
            :style="{ background: d.color, flexGrow: d.count }"
          ></span>
        </span>
        {{ projTotal }}
      </button>
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
        <span class="sync-mark">⟳</span> {{ syncedLabel }}
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
.proj-cell {
  max-width: 300px;
}
.proj-mark {
  color: var(--accent);
}
.proj-bar {
  display: inline-flex;
  width: 56px;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg-hover);
}
.proj-seg {
  min-width: 2px;
}
.net-cell.online {
  color: var(--success);
}
.net-cell.offline {
  color: var(--warning);
}
/* The ⟳ glyph reads smaller than the filled ● dots at the same font
   size — bump it so the status marks align visually. */
.sync-mark {
  font-size: 13px;
  line-height: 1;
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
