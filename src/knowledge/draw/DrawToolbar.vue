<script setup lang="ts">
/**
 * 图片编辑工具条：与 Markdown 工具条同一形态语法（面板头 22px 图标钮、组间竖线、
 * DropdownMenu 下拉、Octicon/自绘图标、tooltip），但命令表是绘图自己的
 * （`session.ts` 的 DRAW_TOOLS——工具是"选中态"而非"执行态"，与 Markdown 命令不同）。
 * 状态直接读写共享会话单例 `drawSession`；撤销/重做交宿主转画布。
 */
import EditorIcon from "../../components/EditorIcon.vue";
import DropdownMenu from "../../components/DropdownMenu.vue";
import { useI18n } from "../../i18n";
import { COLOR_PRESETS, drawSession, DRAW_TOOLS, FONT_CHOICES, WIDTH_CHOICES } from "./session";

const emit = defineEmits<{
  undo: [];
  redo: [];
  rotate: [clockwise: boolean];
  flip: [axis: "h" | "v"];
  cropApply: [];
  cropCancel: [];
}>();

const { t } = useI18n();

const widthItems = WIDTH_CHOICES.map((width) => ({ value: String(width), label: `${width} px` }));
const fontItems = FONT_CHOICES.map((size) => ({ value: String(size), label: `${size} px` }));
</script>

<template>
  <div class="draw-toolbar" role="toolbar" :aria-label="t('kb.editImage')">
    <button
      v-for="tool in DRAW_TOOLS"
      :key="tool.key"
      class="dt-tool"
      :class="{ on: drawSession.tool === tool.key }"
      type="button"
      :title="t(tool.labelKey)"
      :aria-label="t(tool.labelKey)"
      :aria-pressed="drawSession.tool === tool.key"
      @click="drawSession.tool = tool.key"
    >
      <EditorIcon :name="tool.icon" />
    </button>

    <span class="dt-sep" aria-hidden="true" />

    <button
      v-for="color in COLOR_PRESETS"
      :key="color"
      class="dt-swatch"
      :class="{ on: drawSession.color.toLowerCase() === color.toLowerCase() }"
      type="button"
      :style="{ background: color }"
      :title="t('kb.drawColor')"
      :aria-label="`${t('kb.drawColor')} ${color}`"
      @click="drawSession.color = color"
    />
    <label class="dt-picker" :title="t('kb.drawCustomColor')">
      <input type="color" :value="drawSession.color" @input="drawSession.color = ($event.target as HTMLInputElement).value" />
    </label>

    <span class="dt-sep" aria-hidden="true" />

    <DropdownMenu
      class="dt-menu"
      :options="widthItems"
      :model-value="String(drawSession.width)"
      @update:model-value="drawSession.width = Number($event)"
    >
      <template #trigger="{ open, toggle }">
        <button class="dt-size" :class="{ on: open }" type="button" :title="t('kb.drawWidth')" @click="toggle">
          {{ drawSession.width }}px
        </button>
      </template>
    </DropdownMenu>
    <DropdownMenu
      class="dt-menu"
      :options="fontItems"
      :model-value="String(drawSession.fontSize)"
      @update:model-value="drawSession.fontSize = Number($event)"
    >
      <template #trigger="{ open, toggle }">
        <button class="dt-size" :class="{ on: open }" type="button" :title="t('kb.drawFontSize')" @click="toggle">
          {{ drawSession.fontSize }}px
        </button>
      </template>
    </DropdownMenu>

    <span class="dt-sep" aria-hidden="true" />

    <!-- 变换动作组：旋转 / 翻转立即生效（可撤销）；裁剪是两段式——
         框选后这组按钮换「应用 / 取消」 -->
    <button
      v-if="drawSession.tool !== 'crop'"
      class="dt-tool"
      type="button"
      :title="t('kb.drawRotateCcw')"
      :aria-label="t('kb.drawRotateCcw')"
      @click="emit('rotate', false)"
    >
      <EditorIcon name="draw.rotate-ccw" />
    </button>
    <button
      v-if="drawSession.tool !== 'crop'"
      class="dt-tool"
      type="button"
      :title="t('kb.drawRotateCw')"
      :aria-label="t('kb.drawRotateCw')"
      @click="emit('rotate', true)"
    >
      <EditorIcon name="draw.rotate-cw" />
    </button>
    <button
      v-if="drawSession.tool !== 'crop'"
      class="dt-tool"
      type="button"
      :title="t('kb.drawFlipH')"
      :aria-label="t('kb.drawFlipH')"
      @click="emit('flip', 'h')"
    >
      <EditorIcon name="draw.flip-h" />
    </button>
    <button
      v-if="drawSession.tool !== 'crop'"
      class="dt-tool"
      type="button"
      :title="t('kb.drawFlipV')"
      :aria-label="t('kb.drawFlipV')"
      @click="emit('flip', 'v')"
    >
      <EditorIcon name="draw.flip-v" />
    </button>
    <template v-else>
      <button class="dt-size dt-crop-apply" type="button" :title="t('kb.drawCropApply')" @click="emit('cropApply')">
        {{ t("kb.drawCropApply") }}
      </button>
      <button class="dt-size" type="button" :title="t('kb.drawCropCancel')" @click="emit('cropCancel')">
        {{ t("kb.drawCropCancel") }}
      </button>
    </template>

    <span class="dt-sep" aria-hidden="true" />

    <button
      class="dt-tool"
      type="button"
      :disabled="!drawSession.canUndo"
      :title="t('kb.drawUndo')"
      :aria-label="t('kb.drawUndo')"
      @click="emit('undo')"
    >
      <EditorIcon name="draw.undo" />
    </button>
    <button
      class="dt-tool"
      type="button"
      :disabled="!drawSession.canRedo"
      :title="t('kb.drawRedo')"
      :aria-label="t('kb.drawRedo')"
      @click="emit('redo')"
    >
      <EditorIcon name="draw.redo" />
    </button>
  </div>
</template>

<style scoped>
/* 形态对齐 MarkdownToolbar（panel 档：22px 钮、组间竖线、悬停底色） */
.draw-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.draw-toolbar::-webkit-scrollbar {
  display: none;
}
.dt-tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.dt-tool:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.dt-tool.on {
  background: var(--bg-chip);
  color: var(--text);
}
.dt-tool:disabled {
  opacity: 0.35;
  cursor: default;
}
.dt-tool:disabled:hover {
  background: transparent;
  color: var(--text-dim);
}
.dt-sep {
  flex: none;
  width: 1px;
  height: 14px;
  margin: 0 4px;
  background: var(--border);
}
.dt-swatch {
  flex: none;
  width: 13px;
  height: 13px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  cursor: pointer;
}
.dt-swatch.on {
  box-shadow: 0 0 0 1.5px var(--accent);
  border-color: transparent;
}
.dt-picker {
  flex: none;
  display: inline-flex;
  align-items: center;
  width: 16px;
  height: 16px;
  border: 1px dashed var(--border);
  border-radius: 50%;
  overflow: hidden;
  cursor: pointer;
}
.dt-picker:hover {
  border-color: var(--accent);
}
.dt-picker input[type="color"] {
  width: 200%;
  height: 200%;
  padding: 0;
  border: none;
  cursor: pointer;
  background: none;
}
.dt-size {
  flex: none;
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}
.dt-size:hover,
.dt-size.on {
  background: var(--bg-hover);
  color: var(--text);
}
.dt-crop-apply {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
