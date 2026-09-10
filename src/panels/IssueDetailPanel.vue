<script setup lang="ts">
import { storeToRefs } from "pinia";
import { useIssuesStore } from "../stores/issues";
import { useRepoStore } from "../stores/repo";

const issues = useIssuesStore();
const repo = useRepoStore();
const { selected } = storeToRefs(issues);

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
  <section class="panel detail-panel">
    <template v-if="selected">
      <header class="detail-header">
        <div class="detail-title-row">
          <span class="detail-number">#{{ selected.number }}</span>
          <span class="detail-state" :class="selected.state.toLowerCase()">{{ selected.state }}</span>
        </div>
        <h2 class="detail-title">{{ selected.title }}</h2>
        <div class="detail-tags">
          <span v-for="label in selected.labels" :key="label" class="detail-label">{{ label }}</span>
        </div>
      </header>

      <div class="detail-body">
        <pre v-if="selected.body" class="detail-markdown">{{ selected.body }}</pre>
        <p v-else class="detail-nobody">（无描述内容）</p>
      </div>

      <footer class="detail-footer">
        <div class="detail-people">
          <template v-if="selected.author">作者：{{ selected.author }}</template>
          <template v-if="selected.assignees.length">
            　·　负责人：{{ selected.assignees.join(", ") }}
          </template>
        </div>
        <button v-if="selected.url" class="open-github" @click="openUrl(selected.url)">
          在 GitHub 打开
        </button>
      </footer>
    </template>

    <div v-else class="detail-empty">
      <p v-if="repo.current">从左侧选择一个 Issue 查看详情</p>
      <p v-else>先选择一个本地 Git 仓库，然后刷新 Issues</p>
    </div>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-panel);
}
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
.detail-state {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 10px;
}
.detail-state.open {
  color: #3fb950;
  background: rgba(63, 185, 80, 0.12);
}
.detail-state.closed {
  color: #a371f7;
  background: rgba(163, 113, 247, 0.12);
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
.detail-markdown {
  font-family: inherit;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
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
