<script setup lang="ts">
/**
 * Markdown 工具条（共享）：按 `groups` 渲染图标按钮，组间一条竖线，
 * 命令定义来自 `markdown-tools.ts`——工具条、快捷键、右键菜单同一份事实源。
 *
 * 只负责"渲染 + 抛命令"，具体怎么作用到文本由宿主决定
 * （Issue 编辑器作用于 textarea，知识库编辑器作用于 CM6）。
 */
import EditorIcon from "./EditorIcon.vue";
import { useI18n } from "../i18n";
import { commandByKey, type MarkdownCommand } from "./markdown-tools";

const props = defineProps<{
  /** 分组键序（来自 markdown-tools）。 */
  groups: string[][];
  /** 尺寸：panel 用于面板头（22px），form 用于表单编辑器（26px，与既有 Issue 编辑器一致）。 */
  size?: "panel" | "form" | "context";
}>();

const emit = defineEmits<{ run: [command: MarkdownCommand] }>();

const { t } = useI18n();

function commandsOf(group: string[]): MarkdownCommand[] {
  return group.map((key) => commandByKey(key)).filter((c): c is MarkdownCommand => !!c);
}

function tooltip(command: MarkdownCommand): string {
  const label = t(command.labelKey);
  return command.shortcut ? `${label} (${command.shortcut})` : label;
}
</script>

<template>
  <div class="md-toolbar" :class="props.size ?? 'panel'" role="toolbar">
    <template v-for="(group, index) in groups" :key="index">
      <span v-if="index > 0" class="md-tool-sep" aria-hidden="true" />
      <button
        v-for="command in commandsOf(group)"
        :key="command.key"
        class="md-tool"
        type="button"
        :title="tooltip(command)"
        :aria-label="t(command.labelKey)"
        @click="emit('run', command)"
      >
        <EditorIcon :name="command.icon" />
      </button>
    </template>
  </div>
</template>

<style scoped>
.md-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.md-toolbar::-webkit-scrollbar {
  height: 0;
}
.md-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
/* 面板头里比表单里更紧凑（面板头一行只有 34px 高） */
.md-toolbar.panel .md-tool {
  width: 22px;
  height: 22px;
}
.md-tool:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.md-tool-sep {
  flex: none;
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border);
}
</style>
