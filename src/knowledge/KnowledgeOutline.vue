<script setup lang="ts">
/**
 * 大纲侧栏：标题列表 + 当前章节高亮 + 点击跳转。
 *
 * 数据来自编辑器（CM6 语法树），本组件只负责渲染与回传点击——
 * "跟随光标高亮当前章节"是大纲有用与否的分界线（VS Code 就是这么做的），所以不缺省。
 */
import type { OutlineItem } from "./editor/outline";

const props = defineProps<{
  items: OutlineItem[];
  /** 当前章节在 items 中的下标（-1 = 无）。 */
  activeIndex: number;
}>();

const emit = defineEmits<{ jump: [line: number] }>();
</script>

<template>
  <aside class="outline">
    <header class="outline-head">
      <span class="outline-title">大纲</span>
      <span class="outline-count">{{ items.length }}</span>
    </header>
    <p v-if="items.length === 0" class="outline-empty">当前文档没有标题。</p>
    <ul v-else class="outline-list">
      <li v-for="(item, index) in props.items" :key="`${item.line}-${item.text}`">
        <button
          class="outline-item"
          :class="{ active: index === props.activeIndex }"
          :style="{ paddingLeft: `${8 + (item.level - 1) * 12}px` }"
          :title="item.text"
          @click="emit('jump', item.line)"
        >
          <span class="outline-level">H{{ item.level }}</span>
          <span class="outline-text">{{ item.text }}</span>
        </button>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.outline {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
}
.outline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.outline-title {
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.outline-count {
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.outline-empty {
  margin: 10px 12px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.outline-list {
  list-style: none;
  margin: 0;
  padding: 6px 0;
  overflow: auto;
  flex: 1;
  min-height: 0;
}
.outline-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 24px;
  padding-right: 10px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  text-align: left;
  cursor: pointer;
}
.outline-item:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.outline-item.active {
  background: var(--bg-selected);
  color: var(--text);
  font-weight: 600;
}
.outline-level {
  flex: none;
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.outline-item.active .outline-level {
  color: inherit;
}
.outline-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
