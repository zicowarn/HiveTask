<script setup lang="ts">
/**
 * A pair of panes with a draggable divider, nestable to arbitrary depth
 * (the parent of a SplitPane can itself be a SplitPane slot).
 *
 * `direction="horizontal"` = side by side (vertical divider bar).
 */
import { computed, onBeforeUnmount, ref } from "vue";

const props = withDefaults(
  defineProps<{
    direction?: "horizontal" | "vertical";
    initialRatio?: number;
    min?: number;
    // When provided, ratio is controlled by the parent layout tree and
    // changes are emitted back; otherwise an internal ref is used.
    ratio?: number;
  }>(),
  { direction: "horizontal", initialRatio: 0.42, min: 0.15, ratio: undefined }
);

const emit = defineEmits<{ "update:ratio": [ratio: number] }>();

const internalRatio = ref(props.initialRatio);
const ratio = computed({
  get: () => props.ratio ?? internalRatio.value,
  set: (value) => {
    internalRatio.value = value;
    if (props.ratio !== undefined) emit("update:ratio", value);
  },
});
const containerEl = ref<HTMLElement | null>(null);
const dragging = ref(false);

/** 拖拽期的全局锁类名（styles.css）：拖过面板时光标随方向，不是文本光标。 */
const resizeAxisClass = computed(() =>
  props.direction === "horizontal" ? "pane-resizing-x" : "pane-resizing-y",
);

/** 拖拽期间挂 body 上的全局锁（禁选 + 光标）。解锁只有这一个出口——漏了全应用选不中文字。 */
function setResizeLock(on: boolean): void {
  document.body.classList.toggle("pane-resizing", on);
  document.body.classList.toggle(resizeAxisClass.value, on);
}

function onPointerDown(event: PointerEvent) {
  // 必须掐掉默认行为：原生"文字选择"从按下这一刻就开始，拖过分隔条扫到的面板文本
  // （含面板里的控件）会连成蓝底——事后再补 user-select: none 收不回来（KnowledgeTree 同款教训）。
  event.preventDefault();
  dragging.value = true;
  setResizeLock(true);
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  if (!dragging.value || !containerEl.value) return;
  const rect = containerEl.value.getBoundingClientRect();
  const raw =
    props.direction === "horizontal"
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height;
  ratio.value = Math.min(1 - props.min, Math.max(props.min, raw));
}

function onPointerUp() {
  if (!dragging.value) return;
  dragging.value = false;
  setResizeLock(false);
}

onBeforeUnmount(() => setResizeLock(false));
</script>

<template>
  <div
    ref="containerEl"
    class="split-pane"
    :class="direction"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div class="pane" :style="direction === 'horizontal' ? { width: ratio * 100 + '%' } : { height: ratio * 100 + '%' }">
      <slot name="first" />
    </div>
    <div
      class="divider"
      :class="{ active: dragging }"
      @pointerdown="onPointerDown"
      @lostpointercapture="onPointerUp"
    >
      <span class="divider-handle" />
    </div>
    <div class="pane pane-second">
      <slot name="second" />
    </div>
  </div>
</template>

<style scoped>
.split-pane {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--bg-panel);
}
.split-pane.vertical {
  flex-direction: column;
}
.pane {
  overflow: hidden;
  flex: none;
  min-width: 0;
  min-height: 0;
}
.pane-second {
  flex: 1 1 auto;
}
.divider {
  flex: none;
  background: var(--border);
  position: relative;
  z-index: 2;
  transition: background 0.12s ease;
}
/* Child combinator is required: a split can nest inside an opposite-
   direction split, and a descendant selector would leak the outer
   direction's size onto the inner divider (it would collapse to 5x5). */
.split-pane.horizontal > .divider {
  width: 5px;
  cursor: col-resize;
}
.split-pane.vertical > .divider {
  height: 5px;
  cursor: row-resize;
}
.divider:hover,
.divider.active {
  background: var(--accent);
}
.divider-handle {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 2px;
  height: 28px;
  transform: translate(-50%, -50%);
  background: var(--text-dim);
  border-radius: 1px;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.divider:hover .divider-handle,
.divider.active .divider-handle {
  opacity: 0.7;
}
.split-pane.vertical > .divider .divider-handle {
  width: 28px;
  height: 2px;
}
</style>
