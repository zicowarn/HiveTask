<script setup lang="ts">
/**
 * Editor 切换器（PanelShell 左上）——Blender 式：按钮显示当前 Editor 的
 * 「图标 + 文字」，点击弹出**分类分节 + 横向网格**的弹层（非系统菜单、
 * 非竖列）。弹层交互沿用 AppMenu 的可靠配方：兄弟节点定位、外点/Esc
 * 关闭、菜单项 stop 冒泡。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import { editorCategories, panelTypes } from "./panel-types";
import { useI18n } from "../i18n";

const props = defineProps<{ panelType: string }>();
const emit = defineEmits<{ change: [value: string] }>();

const { t } = useI18n();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

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
  open.value = !open.value;
}
function pick(value: string): void {
  emit("change", value);
  open.value = false;
}
function onDocPointerDown(event: MouseEvent): void {
  if (!open.value) return;
  if (rootEl.value && !rootEl.value.contains(event.target as Node)) open.value = false;
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div ref="rootEl" class="editor-switcher">
    <button class="switcher-btn" :aria-expanded="open" :title="t('panel.switchType')" @click="toggle">
      <EditorIcon v-if="current" :name="current.icon" />
      <span v-if="current" class="btn-label">{{ t(current.titleKey) }}</span>
      <span class="btn-caret" :class="{ open }">▾</span>
    </button>

    <div v-if="open" class="switcher-pop" role="menu">
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
  </div>
</template>

<style scoped>
.editor-switcher {
  position: relative;
  min-width: 0;
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

/* Blender 形态：标题行 + 多列并排（每分类一列，列内竖排图标+文字）。 */
.switcher-pop {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  padding: 10px 12px 12px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 9px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
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
  font-size: 11.5px;
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
