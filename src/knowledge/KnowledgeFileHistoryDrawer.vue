<script setup lang="ts">
/**
 * 单文件提交历史（页签/树右键的「查看文件历史」落点）。
 *
 * 数据来自 Rust 的 `git_file_history`：revwalk + 逐提交 diff + **pathspec 按路径过滤**，
 * 所以这里只会看到"碰过这个文件"的提交（而不是整个仓库的历史）。
 */
import { computed, ref, watch } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import SideDrawer from "../components/SideDrawer.vue";
import { api, isTauri } from "../api";
import { useI18n } from "../i18n";
import { translateError } from "../gh-errors";
import type { GitCommitRow } from "../types";

const props = defineProps<{ open: boolean; root: string; rel: string }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const commits = ref<GitCommitRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
/** 扫描上限被触达（提交很多时只显示前 N 个）。 */
const truncated = ref(false);

const fileName = computed(() => props.rel.split("/").pop() ?? props.rel);

function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

function relative(unix: number): string {
  const seconds = unix - Math.floor(Date.now() / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Infinity],
  ];
  let value = seconds;
  for (const [unit, span] of units) {
    if (Math.abs(value) < span) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(value, unit);
    }
    value = Math.round(value / span);
  }
  return String(unix);
}

async function load(): Promise<void> {
  if (!props.open || !props.root || !props.rel || !isTauri()) return;
  loading.value = true;
  error.value = null;
  try {
    const page = await api.gitFileHistory(props.root, props.rel, 100);
    commits.value = page.commits;
    truncated.value = page.hasMore;
  } catch (e) {
    // 「不是 git 仓库」是常见情况（知识库可以指向任意文件夹）——如实说，不装作用
    error.value = translateError(String(e));
    commits.value = [];
  } finally {
    loading.value = false;
  }
}

watch(() => [props.open, props.rel], () => void load(), { immediate: true });
</script>

<template>
  <SideDrawer :open="props.open" :title="t('kb.fileHistory')" @close="emit('close')">
    <div class="fh">
      <header class="fh-head">
        <EditorIcon name="o.git-commit" />
        <span class="fh-name" :title="props.rel">{{ fileName }}</span>
        <span v-if="commits.length" class="fh-count">{{ t("kb.fileHistoryCount", { n: commits.length }) }}</span>
      </header>

      <p v-if="loading" class="fh-note">{{ t("common.loading") }}</p>
      <p v-else-if="error" class="fh-note warn">{{ error }}</p>
      <p v-else-if="commits.length === 0" class="fh-note">{{ t("kb.fileHistoryEmpty") }}</p>

      <ul v-else class="fh-list">
        <li v-for="commit in commits" :key="commit.oid" class="fh-row">
          <div class="fh-row-main">
            <span class="fh-oid" :title="commit.oid">{{ shortOid(commit.oid) }}</span>
            <span class="fh-msg" :title="commit.message">{{ commit.message || t("kb.noCommitMessage") }}</span>
          </div>
          <div class="fh-meta">
            <span v-if="commit.author">{{ commit.author }}</span>
            <span>{{ relative(commit.committedAtUnix) }}</span>
          </div>
        </li>
      </ul>

      <p v-if="truncated" class="fh-note">{{ t("kb.fileHistoryTruncated") }}</p>
    </div>
  </SideDrawer>
</template>

<style scoped>
.fh {
  display: flex;
  flex-direction: column;
  gap: 6px;
  height: 100%;
  min-height: 0;
}
.fh-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.fh-name {
  font-size: var(--font-base);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fh-count {
  margin-left: auto;
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.fh-note {
  margin: 8px 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
  line-height: 1.6;
}
.fh-note.warn {
  color: var(--danger);
}
.fh-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.fh-row {
  padding: 6px 4px;
  border-bottom: 1px solid var(--border);
}
.fh-row-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.fh-oid {
  flex: none;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: var(--font-sm);
  color: var(--accent);
}
.fh-msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-md);
  color: var(--text);
}
.fh-meta {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
</style>
