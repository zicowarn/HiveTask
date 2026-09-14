<script setup lang="ts">
/**
 * 本地分支 review 详情：head→base 预览（提交 + 逐文件 unified patch）+
 * 可合并性横幅 + 三选合并（复用 MergeDialog）+ 合并后删分支提示。
 * 红线：冲突不做解决 UI，诚实提示去终端/编辑器。
 */
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useBranchReviewStore } from "../../stores/branchReview";
import MergeDialog from "../MergeDialog.vue";
import { useI18n } from "../../i18n";

const store = useBranchReviewStore();
const { selected, base, diff, loading, error } = storeToRefs(store);
const { t } = useI18n();

const mergeOpen = ref(false);
const merging = computed(() => loading.value);
const mergedDone = ref(false);

async function onMergeConfirm(method: "merge" | "squash" | "rebase") {
  await store.merge(method);
  if (!store.error) {
    mergeOpen.value = false;
    mergedDone.value = true;
  }
}

// 分支切换/重载后清除"已合并"提示
watch(
  () => selected.value,
  () => (mergedDone.value = false),
);

/** squash 合并不产生祖先关系，安全删会拒绝——内容确认后允许强制删。 */
const lastMethod = ref<"merge" | "squash" | "rebase">("merge");
async function doMerge(method: "merge" | "squash" | "rebase") {
  lastMethod.value = method;
  await onMergeConfirm(method);
}
async function removeBranch() {
  if (!selected.value) return;
  await store.removeBranch(selected.value, lastMethod.value === "squash");
}

const fileOpen = ref<Set<string>>(new Set());
function toggleFile(path: string) {
  const next = new Set(fileOpen.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  fileOpen.value = next;
}

function statusLabel(s: string): string {
  return { added: "A", modified: "M", deleted: "D", renamed: "R" }[s] ?? "M";
}
</script>

<template>
  <div class="brd">
    <p v-if="!selected" class="brd-empty">{{ t("branchReview.pickBranch") }}</p>
    <template v-else>
      <p v-if="error" class="brd-banner error">{{ error }}</p>

      <div class="brd-head">
        <span class="brd-head-branch">{{ selected }}</span>
        <span class="brd-arrow">→</span>
        <span class="brd-head-base">{{ base }}</span>
        <button class="brd-merge-btn" :disabled="loading || !diff || !diff.mergeable" @click="mergeOpen = true">
          {{ t("branchReview.merge") }}
        </button>
      </div>

      <p v-if="diff?.upToDate" class="brd-banner dim">{{ t("branchReview.upToDate") }}</p>
      <p v-else-if="diff?.conflict" class="brd-banner conflict">{{ t("branchReview.conflict") }}</p>
      <p v-else-if="diff?.mergeable" class="brd-banner ok">{{ t("branchReview.mergeable") }}</p>

      <p v-if="mergedDone" class="brd-banner ok">
        {{ t("branchReview.mergedDone") }}
        <button class="brd-link" @click="removeBranch">{{ t("branchReview.deleteBranch") }}</button>
        <span class="brd-dim">/</span>
        <span class="brd-dim">{{ t("branchReview.keepBranch") }}</span>
      </p>

      <div v-if="diff" class="brd-section">
        <h4 class="brd-h">{{ t("branchReview.commits", { n: diff.commits.length }) }}</h4>
        <ul class="brd-commits">
          <li v-for="c in diff.commits" :key="c.oid" class="brd-commit">
            <code class="brd-oid">{{ c.oid.slice(0, 7) }}</code>
            <span class="brd-msg">{{ c.message }}</span>
            <span v-if="c.author" class="brd-author">{{ c.author }}</span>
          </li>
        </ul>
      </div>

      <div v-if="diff" class="brd-section">
        <h4 class="brd-h">
          {{ t("branchReview.files", { n: diff.files.length }) }}
          <span v-if="diff.truncated" class="brd-trunc">{{ t("branchReview.truncated") }}</span>
        </h4>
        <div v-for="f in diff.files" :key="f.path" class="brd-file">
          <button class="brd-file-head" @click="toggleFile(f.path)">
            <span class="brd-status" :data-s="f.status">{{ statusLabel(f.status) }}</span>
            <span class="brd-path">{{ f.path }}</span>
            <span class="brd-diffstat">
              <span class="adds">+{{ f.additions }}</span>
              <span class="dels">−{{ f.deletions }}</span>
            </span>
          </button>
          <pre v-if="fileOpen.has(f.path) && f.patch" class="brd-patch"><code
            v-for="(line, i) in f.patch.split('\n')"
            :key="i"
            :class="line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''"
          >{{ line }}</code></pre>
        </div>
        <p v-if="diff.files.length === 0" class="brd-nofiles">{{ t("branchReview.noFiles") }}</p>
      </div>

      <MergeDialog :open="mergeOpen" :working="merging" @confirm="doMerge" @cancel="mergeOpen = false" />
    </template>
  </div>
</template>

<style scoped>
.brd {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px;
}
.brd-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: var(--font-md);
  padding: 24px 0;
}
.brd-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.brd-head-branch {
  font-size: var(--font-lg);
  font-weight: 700;
  color: var(--text);
}
.brd-arrow,
.brd-head-base {
  font-size: var(--font-md);
  color: var(--text-dim);
}
.brd-merge-btn {
  margin-left: auto;
  border: 1px solid var(--success);
  background: transparent;
  color: var(--success);
  font-size: var(--font-md);
  font-weight: 600;
  height: 26px;
  padding: 0 14px;
  border-radius: 6px;
  cursor: pointer;
}
.brd-merge-btn:hover:not(:disabled) {
  background: var(--success);
  color: var(--bg-panel);
}
.brd-merge-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.brd-banner {
  padding: 7px 10px;
  font-size: var(--font-md);
  border-radius: 6px;
  margin: 0 0 8px;
}
.brd-banner.ok {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, transparent);
  border: 1px solid var(--success);
}
.brd-banner.conflict {
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
}
.brd-banner.error {
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
}
.brd-banner.dim {
  color: var(--text-dim);
  background: var(--bg-app);
  border: 1px solid var(--border);
}
.brd-link {
  border: none;
  background: transparent;
  color: inherit;
  font-size: var(--font-md);
  text-decoration: underline;
  cursor: pointer;
  padding: 0 2px;
}
.brd-dim {
  color: var(--text-dim);
}
.brd-section {
  margin-top: 10px;
}
.brd-h {
  margin: 0 0 6px;
  font-size: var(--font-md);
  color: var(--text-dim);
  font-weight: 600;
}
.brd-trunc {
  color: var(--warning);
  font-weight: 400;
  margin-left: 8px;
}
.brd-commits {
  list-style: none;
  margin: 0;
  padding: 0;
}
.brd-commit {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-md);
  padding: 3px 0;
}
.brd-oid {
  color: var(--accent);
  flex: none;
}
.brd-msg {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.brd-author {
  color: var(--text-dim);
  flex: none;
}
.brd-file {
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 6px;
  overflow: hidden;
}
.brd-file-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  padding: 6px 9px;
  cursor: pointer;
  text-align: left;
}
.brd-file-head:hover {
  background: var(--bg-hover);
}
.brd-status {
  flex: none;
  font-weight: 700;
  font-size: var(--font-sm);
  width: 16px;
  text-align: center;
}
.brd-status[data-s="added"] {
  color: var(--success);
}
.brd-status[data-s="deleted"] {
  color: var(--danger);
}
.brd-status[data-s="renamed"] {
  color: var(--warning);
}
.brd-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, monospace;
}
.brd-diffstat {
  flex: none;
  display: inline-flex;
  gap: 6px;
  font-size: var(--font-sm);
}
.adds {
  color: var(--success);
}
.dels {
  color: var(--danger);
}
.brd-patch {
  margin: 0;
  padding: 6px 0;
  background: var(--bg-app);
  overflow-x: auto;
}
.brd-patch code {
  display: block;
  font-family: ui-monospace, monospace;
  font-size: var(--font-sm);
  line-height: 1.5;
  padding: 0 10px;
  color: var(--text);
  white-space: pre;
}
.brd-patch code.add {
  background: color-mix(in srgb, var(--success) 14%, transparent);
}
.brd-patch code.del {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
}
.brd-patch code.hunk {
  color: var(--accent);
}
.brd-nofiles {
  font-size: var(--font-md);
  color: var(--text-dim);
}
</style>
