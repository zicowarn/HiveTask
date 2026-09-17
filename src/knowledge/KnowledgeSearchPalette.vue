<script setup lang="ts">
/**
 * 全文搜索浮层（⌘⇧F）—— 与 ⌘P 同一种形态：输入 + 结果，Esc 关闭。
 *
 * 为什么不做成左栏的常驻视图：搜索在这里是**只读跳转**（找到就走），不是 VS Code 那种
 * 带替换/多选编辑的工作区。做成浮层后左栏保持"只有文件树"一件事，交互也和 ⌘P 一致。
 * **选中结果不自动关闭** —— 这样才能一边看正文一边逐条点；Esc 才关。
 *
 * 搜索本体在 Rust（`kb_search`）：一次遍历整根、按行返回 1 基行/列。为什么不在前端搜：
 * 一是要读上千个文件（IPC 往返不可接受），二是**中文编码**必须走 `decode_bytes`
 * （GBK/BIG5…），前端拿到 UTF-8 之后就已经错了。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import { api, type KbSearchHit } from "../api";
import { useI18n } from "../i18n";
import { useKnowledgeStore } from "../stores/knowledge";

const emit = defineEmits<{ close: [] }>();
const store = useKnowledgeStore();
const { t } = useI18n();

const query = ref("");
const hits = ref<KbSearchHit[]>([]);
const fileCount = ref(0);
const truncated = ref(false);
const searching = ref(false);
const error = ref<string | null>(null);
const input = ref<HTMLInputElement | null>(null);
/** 当前定位到的命中（点了不关面板，用它标记"刚点的是哪一条"）。 */
const current = ref<KbSearchHit | null>(null);

/** 按文件分组（保持后端顺序：文件内按行号）。 */
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

function isCurrent(hit: KbSearchHit): boolean {
  return current.value?.rel === hit.rel && current.value?.line === hit.line;
}

function jump(hit: KbSearchHit): void {
  current.value = hit;
  store.requestJump(hit.rel, hit.line);
  store.openFile(hit.rel);
}

/** ↑↓ 在命中间走（不用离开输入框）。 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  if (!hits.value.length) return;
  event.preventDefault();
  const index = current.value ? hits.value.findIndex((hit) => isCurrent(hit)) : -1;
  const next = event.key === "ArrowDown" ? index + 1 : index <= 0 ? hits.value.length - 1 : index - 1;
  jump(hits.value[Math.min(Math.max(next, 0), hits.value.length - 1)]);
  void nextTick(() => {
    document.querySelector<HTMLElement>(".sp-hit.on")?.scrollIntoView?.({ block: "nearest" });
  });
}

onMounted(() => void nextTick(() => input.value?.focus()));
onBeforeUnmount(() => {
  if (timer !== null) window.clearTimeout(timer);
});
</script>

<template>
  <div class="sp-backdrop" @click.self="emit('close')">
    <div class="sp" role="dialog" :aria-label="t('kb.search')">
      <div class="sp-input-row">
        <EditorIcon name="o.search" />
        <input
          ref="input"
          v-model="query"
          class="sp-input"
          :placeholder="t('kb.searchPlaceholder')"
          spellcheck="false"
          @keydown="onKeydown"
          @keydown.escape="emit('close')"
        />
        <span class="sp-hint">{{ t("kb.searchHint") }}</span>
      </div>
      <p class="sp-scope">{{ t("kb.searchScope") }}</p>

      <p v-if="error" class="sp-note warn">{{ error }}</p>
      <p v-else-if="searching" class="sp-note">{{ t("common.loading") }}</p>
      <p v-else-if="!query.trim()" class="sp-note">{{ t("kb.searchIdle") }}</p>
      <p v-else-if="!hits.length" class="sp-note">{{ t("kb.searchEmpty") }}</p>
      <template v-else>
        <p class="sp-summary">{{ t("kb.searchSummary", { hits: hits.length, files: fileCount }) }}</p>
        <p v-if="truncated" class="sp-note warn">{{ t("kb.searchTruncated", { hits: hits.length }) }}</p>
        <div class="sp-results">
          <section v-for="group in groups" :key="group.rel" class="sp-group">
            <header class="sp-file" :title="group.rel">
              <span class="file-name">{{ group.name }}</span>
              <span class="file-count">{{ group.hits.length }}</span>
            </header>
            <button
              v-for="hit in group.hits"
              :key="`${hit.line}-${hit.column}`"
              class="sp-hit"
              :class="{ on: isCurrent(hit) }"
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
  </div>
</template>

<style scoped>
.sp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2600;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 72px;
  background: rgb(0 0 0 / 22%);
}
.sp {
  width: min(640px, 90vw);
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  box-shadow: 0 10px 30px rgb(0 0 0 / 35%);
  overflow: hidden;
}
.sp-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
}
.sp-input {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  outline: none;
}
.sp-hint {
  flex: none;
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.sp-scope,
.sp-note,
.sp-summary {
  margin: 0;
  padding: 2px 12px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.sp-scope {
  padding-top: 6px;
}
.sp-note.warn {
  color: var(--warning, var(--text-dim));
}
.sp-results {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding-bottom: 8px;
}
.sp-group {
  margin-top: 6px;
}
.sp-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 2px 12px;
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.file-count {
  flex: none;
  font-size: var(--font-xs);
  font-weight: 400;
  color: var(--text-dim);
}
.sp-hit {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 2px 12px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-sm);
  text-align: left;
  cursor: pointer;
}
.sp-hit:hover {
  background: var(--bg-hover);
}
.sp-hit.on {
  background: var(--bg-selected);
}
.hit-line {
  flex: none;
  min-width: 30px;
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
