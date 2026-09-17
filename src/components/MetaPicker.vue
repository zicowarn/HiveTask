<script setup lang="ts">
/**
 * 元数据选择面板（GitHub issue 侧栏的 Assignees/Labels/Milestone 齿轮面板复刻）：
 * 锚在区头下方（absolute），顶部筛选输入 + 选项行（头像/色点 + 名称 + ✓）。
 * 点击行即发 toggle（写穿透由调用方处理）；multiple 保持展开，单选选后关闭；
 * Esc / 外点关闭。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import EditorIcon from "./EditorIcon.vue";
import { useI18n } from "../i18n";

export interface MetaOption {
  value: string;
  label: string;
  color?: string | null;
  avatar?: string | null;
}

const props = withDefaults(
  defineProps<{
    open: boolean;
    multiple: boolean;
    options: MetaOption[];
    selected: string[];
    placeholder?: string;
    /** 空清单文案。 */
    emptyText?: string;
  }>(),
  { placeholder: "", emptyText: "" },
);
const emit = defineEmits<{ close: []; toggle: [value: string] }>();

const { t } = useI18n();
const query = ref("");
const root = ref<HTMLElement | null>(null);

watch(
  () => props.open,
  (open) => {
    if (open) query.value = "";
  },
);

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return props.options;
  return props.options.filter((o) => o.label.toLowerCase().includes(needle));
});

function pick(option: MetaOption) {
  emit("toggle", option.value);
  if (!props.multiple) emit("close");
}
function onDocPointerDown(event: MouseEvent) {
  if (props.open && root.value && !root.value.contains(event.target as Node)) emit("close");
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && props.open) emit("close");
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
  <div v-if="open" ref="root" class="mp" @pointerdown.stop>
    <input
      v-model="query"
      class="mp-search"
      type="text"
      :placeholder="placeholder"
      spellcheck="false"
    />
    <div class="mp-list">
      <button
        v-for="o in filtered"
        :key="o.value"
        class="mp-row"
        type="button"
        role="option"
        :aria-selected="selected.includes(o.value)"
        @click="pick(o)"
      >
        <img v-if="o.avatar" class="mp-avatar" :src="o.avatar" alt="" />
        <span
          v-else-if="o.color"
          class="mp-dot"
          :style="{ background: o.color.startsWith('#') ? o.color : `#${o.color}` }"
        ></span>
        <span class="mp-label">{{ o.label }}</span>
        <EditorIcon v-if="selected.includes(o.value)" class="mp-check" name="o.check" />
      </button>
      <p v-if="filtered.length === 0" class="mp-empty">{{ emptyText || t("issue.noneAvailable") }}</p>
    </div>
  </div>
</template>

<style scoped>
/* 平台形态：区头下方浮出面板，白底描边圆角 + 投影，约 300px 宽 */
.mp {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 90;
  width: 300px;
  max-width: 78vw;
  padding: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.mp-search {
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  margin-bottom: 6px;
  font-size: var(--font-md);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 8px;
  outline: none;
}
.mp-search:focus {
  border-color: var(--accent);
}
.mp-list {
  max-height: 260px;
  overflow-y: auto;
}
.mp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 6px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.mp-row:hover {
  background: var(--bg-hover);
}
.mp-avatar {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}
.mp-dot {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid var(--border);
}
.mp-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-check {
  flex: none;
  color: var(--text);
}
.mp-empty {
  margin: 0;
  padding: 6px;
  font-size: var(--font-md);
  color: var(--text-dim);
}
</style>
