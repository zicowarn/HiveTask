<script setup lang="ts">
/**
 * A pair of panes with a draggable divider, nestable to arbitrary depth
 * (the parent of a SplitPane can itself be a SplitPane slot).
 *
 * `direction="horizontal"` = side by side (vertical divider bar).
 */
import { computed, ref } from "vue";

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

function onPointerDown(event: PointerEvent) {
  dragging.value = true;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
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
  dragging.value = false;
}
</script>

<template>
  <div
    ref="containerEl"
    class="split-pane"
    :class="direction"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
  >
    <div class="pane" :style="direction === 'horizontal' ? { width: ratio * 100 + '%' } : { height: ratio * 100 + '%' }">
      <slot name="first" />
    </div>
    <div
      class="divider"
      :class="{ active: dragging }"
      @pointerdown="onPointerDown"
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
