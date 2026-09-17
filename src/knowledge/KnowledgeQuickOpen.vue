<script setup lang="ts">
/**
 * ⌘P 快速打开：一个居中的输入条 + 结果列表（VS Code 口径）。
 *
 * 数据来自 `kb_walk`（一次遍历整根，懒加载并缓存）；匹配与排序在
 * `quick-open.ts`（纯函数，单测覆盖）。空查询给「最近打开」——
 * ⌘P 最常用的用法是回到刚才那个文件，而不是真去找。
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useI18n } from "../i18n";
import { useKnowledgeStore } from "../stores/knowledge";
import { rankFiles, type QuickOpenItem } from "./quick-open";
import { iconForFile } from "./file-icon";

const emit = defineEmits<{ close: [] }>();
const store = useKnowledgeStore();
const { t } = useI18n();

const query = ref("");
const items = ref<QuickOpenItem[]>([]);
const active = ref(0);
const loading = ref(false);
const input = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

const visible = computed(() => items.value.slice(0, 100));

async function reload(): Promise<void> {
  if (!store.root) return;
  loading.value = true;
  try {
    const files = await store.loadFileIndex();
    items.value = rankFiles(files, query.value, store.recentFiles);
    active.value = 0;
  } catch {
    items.value = [];
  } finally {
    loading.value = false;
  }
}

watch(query, () => void reload(), { immediate: true });

function move(delta: number): void {
  if (!visible.value.length) return;
  active.value = (active.value + delta + visible.value.length) % visible.value.length;
  void nextTick(() => {
    // `?.` 调用：jsdom 这类宿主没有 scrollIntoView，滚动失败不该让选中断掉
    listEl.value?.querySelector<HTMLElement>(".qo-row.active")?.scrollIntoView?.({ block: "nearest" });
  });
}

function open(item: QuickOpenItem | undefined): void {
  if (!item) return;
  store.openFile(item.rel);
  emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    open(visible.value[active.value]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
  }
}

onMounted(() => void nextTick(() => input.value?.focus()));
</script>

<template>
  <div class="qo-backdrop" @click.self="emit('close')">
    <div class="qo" role="dialog" :aria-label="t('kb.quickOpen')">
      <div class="qo-input-row">
        <EditorIcon name="o.search" />
        <input
          ref="input"
          v-model="query"
          class="qo-input"
          :placeholder="t('kb.quickOpenPlaceholder')"
          spellcheck="false"
          @keydown="onKeydown"
        />
        <span class="qo-hint">{{ t("kb.quickOpenHint") }}</span>
      </div>
      <p v-if="loading" class="qo-note">{{ t("common.loading") }}</p>
      <p v-else-if="!visible.length" class="qo-note">{{ t("kb.quickOpenEmpty") }}</p>
      <ul v-else ref="listEl" class="qo-list">
        <li
          v-for="(item, index) in visible"
          :key="item.rel"
          class="qo-row"
          :class="{ active: index === active }"
          :title="item.rel"
          @mousemove="active = index"
          @click="open(item)"
        >
          <EditorIcon class="qo-icon" :name="iconForFile(item.name)" />
          <span class="qo-name">{{ item.name }}</span>
          <span class="qo-dir">{{ item.dir }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.qo-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2600;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 84px;
  background: rgb(0 0 0 / 22%);
}
.qo {
  width: min(560px, 86vw);
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  box-shadow: 0 10px 30px rgb(0 0 0 / 35%);
  overflow: hidden;
}
.qo-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text-dim);
}
.qo-input {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  outline: none;
}
.qo-hint {
  flex: none;
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.qo-note {
  margin: 0;
  padding: 10px 12px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.qo-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 4px 0;
  list-style: none;
}
.qo-row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  padding: 0 10px;
  font-size: var(--font-base);
  color: var(--text);
  cursor: pointer;
}
.qo-row.active {
  background: var(--bg-selected);
}
.qo-icon {
  flex: none;
  color: var(--text-dim);
}
.qo-name {
  flex: none;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.qo-dir {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-sm);
  color: var(--text-dim);
  direction: rtl; /* 路径太长时保留末段（更常用） */
  text-align: left;
}
</style>
