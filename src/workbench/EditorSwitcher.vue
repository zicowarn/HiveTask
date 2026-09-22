<script setup lang="ts">
/**
 * Editor 切换器（PanelShell 左上）——Blender 式：按钮显示当前 Editor 的
 * 「图标 + 文字」，点击弹出**分类分节 + 横向网格**的弹层（非系统菜单、
 * 非竖列）。弹层 **Teleport 到 body + fixed 定位**（同 DropdownMenu 配方）：
 * 留在面板内会被 `.pane` 的 overflow 裁掉——分栏时弹层右半被右栏切掉；
 * 外点/Esc 关闭、菜单项 stop 冒泡。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import { editorCategories, panelTypes } from "./panel-types";
import { useI18n } from "../i18n";

const props = defineProps<{ panelType: string }>();
const emit = defineEmits<{ change: [value: string] }>();

const { t } = useI18n();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);
/** 弹层本体（Teleport 到 body）与它的内联 fixed 定位。 */
const popEl = ref<HTMLElement | null>(null);
const popStyle = ref<Record<string, string>>({});
/** 弹层自然尺寸：宽度由列数决定（列自带 min-width），定位要按它夹取。 */
const popSize = ref({ width: 0, height: 0 });

const current = computed(() => panelTypes.find((p) => p.type === props.panelType));

/** 分类 → 该类下的 Editor（保持 panelTypes 的声明顺序）。 */
const sections = computed(() =>
  editorCategories
    .map((category) => ({
      category,
      items: panelTypes.filter((p) => p.category === category),
    }))
    .filter((section) => section.items.length > 0),
);

function toggle(): void {
  if (open.value) {
    open.value = false;
    return;
  }
  // 弹层是 v-if 新建的：先清掉上一轮的定位/封顶，才量得到自然尺寸
  popStyle.value = {};
  open.value = true;
}

/** 量弹层自然尺寸（定位与翻转判断都用它）。 */
function measure(): void {
  const el = popEl.value;
  if (el) popSize.value = { width: el.offsetWidth, height: el.offsetHeight };
}

/** 按触发器 rect 定位弹层（position: fixed）；右边界夹取，下方放不下时向上翻。 */
function place(): void {
  const el = rootEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const GAP = 5;
  const MARGIN = 6;
  const { width, height } = popSize.value;
  const left = Math.min(
    Math.max(MARGIN, rect.left),
    Math.max(MARGIN, window.innerWidth - width - MARGIN),
  );
  const spaceBelow = window.innerHeight - rect.bottom - GAP - MARGIN;
  const spaceAbove = rect.top - GAP - MARGIN;
  const flip = height > spaceBelow && spaceAbove > spaceBelow;
  popStyle.value = {
    position: "fixed",
    left: `${left}px`,
    ...(flip
      ? { bottom: `${window.innerHeight - rect.top + GAP}px`, top: "auto" }
      : { top: `${rect.bottom + GAP}px`, bottom: "auto" }),
    maxHeight: `${Math.max(120, flip ? spaceAbove : spaceBelow)}px`,
  };
}

function pick(value: string): void {
  emit("change", value);
  open.value = false;
}
function onDocPointerDown(event: MouseEvent): void {
  if (!open.value) return;
  const target = event.target as Node;
  if (rootEl.value?.contains(target) || popEl.value?.contains(target)) return;
  open.value = false;
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") open.value = false;
}

watch(open, (isOpenNow) => {
  if (isOpenNow) {
    // 定位在同一帧内完成（nextTick 先于绘制），不会闪
    void nextTick(() => {
      measure();
      place();
    });
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
  } else {
    window.removeEventListener("scroll", place, true);
    window.removeEventListener("resize", place);
  }
});

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("scroll", place, true);
  window.removeEventListener("resize", place);
});
</script>

<template>
  <div ref="rootEl" class="editor-switcher">
    <button class="switcher-btn" :aria-expanded="open" :title="t('panel.switchType')" @click="toggle">
      <EditorIcon v-if="current" :name="current.icon" />
      <span v-if="current" class="btn-label">{{ t(current.titleKey) }}</span>
      <span class="btn-caret" :class="{ open }">▾</span>
    </button>

    <Teleport to="body">
      <div v-if="open" ref="popEl" class="switcher-pop" :style="popStyle" role="menu">
        <div class="pop-title">{{ t("panel.switchType") }}</div>
        <div class="pop-columns">
          <section v-for="section in sections" :key="section.category" class="pop-column">
            <div class="column-title">{{ t(section.category) }}</div>
            <button
              v-for="item in section.items"
              :key="item.type"
              class="editor-item"
              role="menuitemradio"
              :aria-checked="item.type === panelType"
              :class="{ current: item.type === panelType }"
              @click.stop="pick(item.type)"
            >
              <EditorIcon :name="item.icon" />
              <span class="item-label">{{ t(item.titleKey) }}</span>
            </button>
          </section>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.editor-switcher {
  position: relative;
  /* 固定尺寸：不得被页签条挤压。一旦这个盒子收缩，里面的按钮会溢出自身边界，
     把与右侧的间隙"吃掉"——实机截图里切换器与方向按钮贴住就是这个原因。 */
  flex: none;
}
.switcher-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  line-height: 1;
  padding: 0 7px;
  cursor: pointer;
  outline: none;
}
.switcher-btn:hover,
.switcher-btn:focus-visible,
.switcher-btn[aria-expanded="true"] {
  border-color: var(--accent);
  color: var(--accent);
}
.btn-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.btn-caret {
  font-size: var(--font-xs);
  color: var(--text-dim);
  transition: transform 0.15s ease;
}
.btn-caret.open {
  transform: rotate(180deg);
}

/* Blender 形态：标题行 + 多列并排（每分类一列，列内竖排图标+文字）。
   定位/封顶由内联 fixed 样式给（Teleport 到 body，逃出面板 overflow 裁剪）。 */
.switcher-pop {
  z-index: 400;
  display: flex;
  flex-direction: column;
  max-width: calc(100vw - 12px);
  padding: 10px 12px 12px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 9px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
  overflow: auto;
}
.pop-title {
  font-size: var(--font-md);
  color: var(--text);
  padding-bottom: 7px;
  margin-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.pop-columns {
  display: flex;
  gap: 8px;
}
.pop-column {
  display: flex;
  flex-direction: column;
  min-width: 128px;
}
.column-title {
  /* 分类标题 = 弹层里的组头元数据：低条目文本一档（--font-md → --font-sm） */
  font-size: var(--font-sm);
  color: var(--text-dim);
  padding: 2px 6px 6px;
}
.editor-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  line-height: 1;
  height: 26px;
  padding: 0 6px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  text-align: left;
}
.editor-item:hover {
  background: var(--bg-hover);
}
.editor-item.current {
  background: var(--bg-selected);
  color: var(--accent);
}
.item-label {
  white-space: nowrap;
}
</style>
