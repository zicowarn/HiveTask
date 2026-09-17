<script setup lang="ts">
/**
 * 全文搜索视图（在知识库左栏里替换文件树，MarkText 的 sidebar 搜索同构）。
 *
 * 搜索在 **Rust** 侧做（`kb_search`）：一次遍历整根、按行命中、按键名带行号返回。
 * 为什么不在前端搜：一是要读上千个文件（IPC 往返不可接受），二是**中文编码**必须走
 * `decode_bytes`（GBK/BIG5…），前端拿到 UTF-8 之后就已经错了。
 *
 * 结果按文件分组，点击跳到该行（走 store 的 `requestJump` → 预览面板消费）。
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import { api, type KbSearchHit } from "../api";
import { useI18n } from "../i18n";
import { useKnowledgeStore } from "../stores/knowledge";

const store = useKnowledgeStore();
const { t } = useI18n();

const query = ref("");
const hits = ref<KbSearchHit[]>([]);
const fileCount = ref(0);
const truncated = ref(false);
const searching = ref(false);
const error = ref<string | null>(null);
const input = ref<HTMLInputElement | null>(null);

/** 按文件分组（保持后端给出的顺序：文件内按行号）。 */
const groups = computed(() => {
  const map = new Map<string, KbSearchHit[]>();
  for (const hit of hits.value) {
    const list = map.get(hit.rel);
    if (list) list.push(hit);
    else map.set(hit.rel, [hit]);
  }
  return [...map.entries()].map(([rel, list]) => ({ rel, name: rel.split("/").pop() ?? rel, hits: list }));
});

let timer: number | null = null;
/** 请求序号：慢的旧请求回来时丢弃（否则会把新结果覆盖成旧的）。 */
let requestId = 0;

async function run(): Promise<void> {
  const base = store.root;
  const needle = query.value.trim();
  error.value = null;
  if (!base || !needle) {
    hits.value = [];
    fileCount.value = 0;
    truncated.value = false;
    return;
  }
  const id = ++requestId;
  searching.value = true;
  try {
    const result = await api.kbSearch(base, needle, store.showIgnored);
    if (id !== requestId) return; // 过期的响应
    hits.value = result.hits;
    fileCount.value = result.files;
    truncated.value = result.truncated;
  } catch (e) {
    if (id === requestId) error.value = String(e);
  } finally {
    if (id === requestId) searching.value = false;
  }
}

/** 输入防抖 220ms：每敲一个字都遍历整根太浪费（大库上很明显）。 */
watch(query, () => {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void run();
  }, 220);
});

function jump(hit: KbSearchHit): void {
  store.requestJump(hit.rel, hit.line);
  store.openFile(hit.rel);
}

function focusInput(): void {
  input.value?.focus();
}

defineExpose({ focusInput });

onBeforeUnmount(() => {
  if (timer !== null) window.clearTimeout(timer);
});
</script>

<template>
  <div class="kb-search">
    <div class="search-input-row">
      <EditorIcon name="o.search" class="leading" />
      <input
        ref="input"
        v-model="query"
        class="search-input"
        :placeholder="t('kb.searchPlaceholder')"
        spellcheck="false"
        @keydown.escape="query = ''"
      />
    </div>
    <p class="search-scope">{{ t("kb.searchScope") }}</p>

    <p v-if="error" class="search-note warn">{{ error }}</p>
    <p v-else-if="searching" class="search-note">{{ t("common.loading") }}</p>
    <p v-else-if="!query.trim()" class="search-note">{{ t("kb.searchIdle") }}</p>
    <p v-else-if="!hits.length" class="search-note">{{ t("kb.searchEmpty") }}</p>
    <template v-else>
      <p class="search-summary">
        {{ t("kb.searchSummary", { hits: hits.length, files: fileCount }) }}
      </p>
      <p v-if="truncated" class="search-note warn">
        {{ t("kb.searchTruncated", { hits: hits.length }) }}
      </p>
      <div class="search-results">
        <section v-for="group in groups" :key="group.rel" class="search-group">
          <header class="search-file" :title="group.rel">
            <span class="file-name">{{ group.name }}</span>
            <span class="file-count">{{ group.hits.length }}</span>
          </header>
          <button
            v-for="hit in group.hits"
            :key="`${hit.line}-${hit.column}`"
            class="search-hit"
            :title="hit.text"
            @click="jump(hit)"
          >
            <span class="hit-line">{{ hit.line }}</span>
            <span class="hit-text">{{ hit.text }}</span>
          </button>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.kb-search {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.search-input-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  margin: 6px 8px 4px;
  padding: 0 8px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-dim);
}
.search-input {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  outline: none;
}
.search-scope,
.search-note,
.search-summary {
  margin: 0;
  padding: 2px 10px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.search-note.warn {
  color: var(--warning, var(--text-dim));
}
.search-results {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding-bottom: 8px;
}
.search-group {
  margin-top: 6px;
}
.search-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 2px 10px;
  font-size: var(--font-base);
  color: var(--text);
  font-weight: 600;
}
.file-count {
  flex: none;
  font-size: var(--font-xs);
  font-weight: 400;
  color: var(--text-dim);
}
.search-hit {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 2px 10px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-sm);
  text-align: left;
  cursor: pointer;
}
.search-hit:hover {
  background: var(--bg-hover);
}
.hit-line {
  flex: none;
  min-width: 26px;
  text-align: right;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.hit-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
