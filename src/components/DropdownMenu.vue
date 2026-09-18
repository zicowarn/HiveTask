<script setup lang="ts">
/**
 * 统一下拉菜单（全应用唯一下拉形态，AGENTS.md 强制约定）：
 * 触发器 = setting-select 同款描边小盒（22px、右 chevron、亮色换图）；
 * 菜单面板 = 扁平 ✓ 勾选行（纯色底、无系统渐变弹层）。单选即选即关；
 * `checkbox` 变体（日历图层选择器这类）：行 = 色点 + 名称 + 右侧方框勾选；
 * multiple 时保持展开连续勾选，值为 string[]。外部点击 / Esc 关闭。
 *
 * 菜单 **Teleport 到 body + fixed 定位**：历史上菜单用绝对定位挂在触发器旁，
 * 落在看板列/抽屉这类 overflow 容器里会被裁掉（AGENTS.md 记录的坑）。改为
 * 打开时按触发器 rect 定位、滚动/缩放跟随，祖先 overflow 不再是问题。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import EditorIcon from "./EditorIcon.vue";
import { t } from "../i18n";

export interface DropdownOption {
  value: string;
  label: string;
  /** 可选色点（标签类选项）。 */
  color?: string | null;
  /** 可选行首图标（EditorIcon 名；如仓库下拉的私有锁）。 */
  icon?: string;
}

/** 分组（平台的 Actions 菜单形态：组标题 + 组内条目）。给了 sections 就忽略 options。 */
export interface DropdownSection {
  title?: string;
  options: DropdownOption[];
}

/** 顶部动作行（如看板 ＋ 菜单的「New column」）——点击发 action 事件。 */
export interface DropdownAction {
  value: string;
  label: string;
  icon?: string;
}

const props = withDefaults(
  defineProps<{
    options?: DropdownOption[];
    /** 分组列表（与 options 二选一；有 sections 时按平台菜单形态渲染）。 */
    sections?: DropdownSection[];
    /** 顶部动作行（可选；有它时菜单顶部多一段分隔 + 动作条目）。 */
    action?: DropdownAction | null;
    modelValue: string | string[];
    multiple?: boolean;
    /** 单选且值为空时的占位文案。 */
    placeholder?: string;
    disabled?: boolean;
    /** 长列表（应用清单这类上百条）：菜单顶部多一个搜索框，按标签实时过滤。 */
    filterable?: boolean;
    /** 勾选框变体（多选）：行尾渲染方框勾选（替代文本 ✓），配合 option.color 色点。 */
    checkbox?: boolean;
  }>(),
  {
    options: () => [],
    sections: () => [],
    action: null,
    multiple: false,
    placeholder: "",
    disabled: false,
    filterable: false,
    checkbox: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string | string[]];
  action: [value: string];
  /** 开合变化（调用方据此懒加载菜单内容，例如"这个扩展名系统里有哪些应用"）。 */
  openChange: [value: boolean];
}>();


const open = ref(false);
const root = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const filterInput = ref<HTMLInputElement | null>(null);
/** 搜索词（`filterable` 时菜单顶部的输入框）。 */
const query = ref("");
/** 菜单内联定位（position: fixed；top/bottom 二选一 + maxHeight）。 */
const menuStyle = ref<Record<string, string>>({});

const selected = computed(() =>
  Array.isArray(props.modelValue) ? props.modelValue : [props.modelValue].filter((v) => v !== ""),
);

/** 全部条目（分组时拍平）——触发器文案与空态判断共用。 */
const allOptions = computed(() =>
  props.sections.length ? props.sections.flatMap((s) => s.options) : props.options,
);
/** 平台菜单形态（分组 + 动作行 + 行首 ✓）：看板 ＋ 这类菜单用它。 */
const menuForm = computed(() => props.sections.length > 0 || !!props.action);

const triggerLabel = computed(() => {
  if (selected.value.length === 0) return props.placeholder;
  return allOptions.value
    .filter((o) => selected.value.includes(o.value))
    .map((o) => o.label)
    .join(", ");
});

const isEmpty = computed(() => selected.value.length === 0 || triggerLabel.value === "");

function isOpen(value: string): boolean {
  return selected.value.includes(value);
}

/** 色点取色：# 开头原样；CSS 颜色函数（var()/rgb()/hsl()）原样；裸值补 #。 */
function dotColor(color: string): string {
  if (color.startsWith("#") || /^(var\(|rgb|hsl)/.test(color)) return color;
  return `#${color}`;
}

/** 按触发器 rect 定位菜单；下方空间不足时向上翻。 */
function place() {
  const el = root.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const GAP = 3;
  const MARGIN = 6;
  const MAX = menuForm.value ? 380 : 260;
  const spaceBelow = window.innerHeight - rect.bottom - GAP - MARGIN;
  const spaceAbove = rect.top - GAP - MARGIN;
  const width = Math.max(rect.width, menuForm.value ? 200 : props.checkbox ? 190 : 120);
  const left = Math.min(Math.max(MARGIN, rect.left), Math.max(MARGIN, window.innerWidth - width - MARGIN));
  if (spaceBelow < Math.min(MAX, 140) && spaceAbove > spaceBelow) {
    menuStyle.value = {
      position: "fixed",
      left: `${left}px`,
      bottom: `${window.innerHeight - rect.top + GAP}px`,
      width: `${width}px`,
      maxHeight: `${Math.min(MAX, spaceAbove)}px`,
      top: "auto",
    };
  } else {
    menuStyle.value = {
      position: "fixed",
      left: `${left}px`,
      top: `${rect.bottom + GAP}px`,
      width: `${width}px`,
      maxHeight: `${Math.min(MAX, Math.max(80, spaceBelow))}px`,
      bottom: "auto",
    };
  }
}

function toggle() {
  setOpen(!open.value);
}

function setOpen(next: boolean) {
  if (open.value === next) return;
  open.value = next;
  emit("openChange", next);
}

/** 搜索框里回车：选第一个命中项（长列表里省一次鼠标）。 */
function pickFirstMatch() {
  const first = groups.value[0]?.options[0];
  if (first) pick(first);
}

function pick(option: DropdownOption) {
  if (props.multiple) {
    const current = Array.isArray(props.modelValue) ? props.modelValue : [];
    const next = current.includes(option.value)
      ? current.filter((v) => v !== option.value)
      : [...current, option.value];
    emit("update:modelValue", next); // 多选保持展开
  } else {
    emit("update:modelValue", option.value);
    setOpen(false);
  }
}

function onDocClick(event: MouseEvent) {
  if (!open.value) return;
  const target = event.target as Node;
  if (root.value?.contains(target) || menu.value?.contains(target)) return;
  setOpen(false);
}

function onDocKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && open.value) {
    event.stopPropagation();
    setOpen(false);
  }
}

/** 归一为分组：无 sections 时视作单组（不带标题）。 */
const baseGroups = computed<DropdownSection[]>(() =>
  props.sections.length ? props.sections : [{ options: props.options }],
);

/** 搜索过滤后的分组（空组直接不渲染；未开启搜索时原样）。 */
const groups = computed<DropdownSection[]>(() => {
  const needle = query.value.trim().toLowerCase();
  if (!props.filterable || !needle) return baseGroups.value;
  return baseGroups.value
    .map((group) => ({ ...group, options: group.options.filter((o) => o.label.toLowerCase().includes(needle)) }))
    .filter((group) => group.options.length > 0);
});

function pickAction(item: DropdownAction) {
  emit("action", item.value);
  setOpen(false);
}

watch(open, (isOpenNow) => {
  if (isOpenNow) {
    query.value = "";
    void nextTick(() => {
      place();
      filterInput.value?.focus();
    });
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
  } else {
    window.removeEventListener("scroll", place, true);
    window.removeEventListener("resize", place);
  }
});

onMounted(() => {
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("keydown", onDocKeydown, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick, true);
  document.removeEventListener("keydown", onDocKeydown, true);
  window.removeEventListener("scroll", place, true);
  window.removeEventListener("resize", place);
});
</script>

<template>
  <div ref="root" class="dd">
    <slot name="trigger" :open="open" :toggle="toggle">
      <button
        class="dd-trigger"
        type="button"
        :class="{ open }"
        :disabled="disabled"
        @click="toggle"
      >
        <span class="dd-label" :class="{ dim: isEmpty }">{{ triggerLabel || placeholder || "…" }}</span>
        <svg class="dd-chev" :class="{ open }" viewBox="0 0 10 10" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 3.5L5 6.5L8 3.5" />
        </svg>
      </button>
    </slot>
    <Teleport to="body">
      <div
        v-if="open"
        ref="menu"
        class="dd-menu"
        :class="{ form: menuForm }"
        :style="menuStyle"
        role="listbox"
        :aria-multiselectable="multiple"
      >
        <!-- 搜索框（长列表用：应用清单这类上百条） -->
        <input
          v-if="filterable"
          ref="filterInput"
          v-model="query"
          class="dd-filter"
          type="text"
          spellcheck="false"
          :placeholder="placeholder"
          @keydown.enter.prevent="pickFirstMatch"
          @keydown.esc.stop="setOpen(false)"
        />
        <!-- 动作行（平台菜单顶部：＋ New column，之下一条分隔线） -->
        <template v-if="action">
          <button class="dd-act" type="button" role="menuitem" @click="pickAction(action)">
            <EditorIcon v-if="action.icon" :name="action.icon" />
            <span class="dd-act-label">{{ action.label }}</span>
          </button>
          <div v-if="sections.length" class="dd-sep"></div>
        </template>
        <template v-for="(group, gi) in groups" :key="group.title ?? gi">
          <p v-if="group.title" class="dd-group">{{ group.title }}</p>
          <button
            v-for="option in group.options"
            :key="option.value"
            class="dd-row"
            type="button"
            role="option"
            :aria-selected="isOpen(option.value)"
            @click="pick(option)"
          >
            <!-- 平台菜单形态：行首 ✓（选中可见，未选中留位对齐） -->
            <EditorIcon
              v-if="menuForm"
              name="o.check"
              class="dd-lead"
              :class="{ on: isOpen(option.value) }"
            />
            <EditorIcon v-else-if="option.icon" :name="option.icon" />
            <span v-if="option.color" class="dd-dot" :style="{ background: dotColor(option.color) }"></span>
            <span class="dd-row-label">{{ option.label }}</span>
            <span
              v-if="checkbox"
              class="dd-checkbox"
              :class="{ on: isOpen(option.value) }"
              aria-hidden="true"
            >
              <EditorIcon v-if="isOpen(option.value)" name="o.check" />
            </span>
            <span v-else-if="!menuForm" class="dd-check" :class="{ on: isOpen(option.value) }">✓</span>
          </button>
        </template>
        <p v-if="groups.length === 0" class="dd-empty">{{ t("issue.noneAvailable") }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.dd {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  min-width: 0;
}
/* 触发器：与 setting-select 同款（描边小盒 + 右 chevron，22px） */
.dd-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  padding: 0 6px 0 8px;
  cursor: pointer;
  outline: none;
  min-width: 0;
}
.dd-trigger:hover,
.dd-trigger.open {
  border-color: var(--accent);
}
.dd-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dd-label.dim {
  color: var(--text-dim);
}
.dd-chev {
  flex: none;
  color: var(--text-dim);
  transition: transform 0.12s;
}
.dd-chev.open {
  transform: rotate(180deg);
}
/* 菜单面板：扁平 ✓ 勾选行（纯色，无系统弹层）；定位由内联 fixed 样式给 */
.dd-menu {
  z-index: 400;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
  padding: 2px;
}
.dd-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
}
.dd-row:hover {
  background: var(--bg-hover);
}
.dd-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 5px;
  border: 1px solid var(--border);
}
.dd-row-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dd-check {
  flex: none;
  width: 12px;
  color: var(--accent);
  visibility: hidden;
}
.dd-check.on {
  visibility: visible;
}
/* 勾选框变体：方框 + 选中 accent 底白勾（日历图层选择器同款） */
.dd-checkbox {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-app);
  color: #fff;
}
.dd-checkbox.on {
  background: var(--accent);
  border-color: var(--accent);
}
.dd-checkbox .editor-icon {
  --icon-size: 10px;
}
.dd-empty {
  margin: 0;
  padding: 4px 6px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* ---- 平台菜单形态（分组 + 动作行 + 行首 ✓）----
   平台实测：面板圆角 8、行高 32、条目 14px、组标题 12px/600 次级色 */
.dd-menu.form {
  padding: 4px;
  border-radius: 8px;
}
.dd-menu.form .dd-row {
  gap: 8px;
  height: 32px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: var(--font-lg);
}
.dd-act {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: var(--font-lg);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.dd-act:hover {
  background: var(--bg-hover);
}
.dd-act .editor-icon {
  color: var(--text-dim);
}
.dd-act-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 搜索框（filterable）：与菜单同宽，样式走 token（无原生外观） */
.dd-filter {
  display: block;
  width: 100%;
  height: 24px;
  margin: 2px 0 4px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-family: inherit;
  font-size: var(--font-md);
  outline: none;
}
.dd-filter:focus {
  border-color: var(--accent);
}
.dd-sep {
  height: 1px;
  margin: 4px -4px;
  background: var(--border);
}
.dd-group {
  margin: 6px 8px 4px;
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--text-dim);
}
/* 行首 ✓：选中可见，未选中占位保持文字对齐（平台同款） */
.dd-lead {
  flex: none;
  color: var(--text);
  visibility: hidden;
}
.dd-lead.on {
  visibility: visible;
}
</style>
