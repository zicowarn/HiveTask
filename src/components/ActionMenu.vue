<script setup lang="ts">
/**
 * 动作菜单（应用级原语）——用于「⋯」这类**命令**菜单，区别于 DropdownMenu
 * 的「选择」语义（那是有 modelValue、带 ✓ 的取值控件）。
 * 形态对齐 GitHub 的 Actions 菜单（平台实测）：行高 32 / 14px 文本 / 行首
 * Octicon 次级色 / 行前分组分隔线（通栏）/ 快捷键角标（20×20 描边）/ 危险项
 * 红字 / 二级行右侧 chevron；可分组（组标题 + 组间分隔）。
 *
 * 与 DropdownMenu 共用交互口径：外点 / Esc 关闭，点击项后关闭。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import EditorIcon from "./EditorIcon.vue";

export interface ActionItem {
  value: string;
  label: string;
  /** 组标题（同组连续项共享；空 = 不分组）。 */
  group?: string;
  /** 危险动作（删除类）红字。 */
  danger?: boolean;
  /** 行首图标（EditorIcon 名称；Octicon 族用 "o.*"）。 */
  icon?: string;
  /** 快捷键角标（平台：Archive 的 E、Remove from project 的 Del）。 */
  badge?: string;
  /** 隐藏右侧子菜单箭头（平台 Move item 行：只有左 grabber，无右箭头）。 */
  noChevron?: boolean;
  /** 二级面板条目（如「移动到列」）；点击本行进入二级面板。 */
  submenu?: ActionItem[];
  /** 本行之前画一条分组分隔线（平台菜单形态）。 */
  dividerBefore?: boolean;
  /** 禁用项（平台形态：灰字、不可点，如最左列的 Move left）。 */
  disabled?: boolean;
  /** 提示副行（平台禁用项的第二行，如「This is the left-most column」）。 */
  hint?: string;
}

const props = withDefaults(
  defineProps<{
    items: ActionItem[];
    /** 触发器图标名（如 "ellipsis"）；给了就只渲图标，不渲文字。 */
    triggerIcon?: string;
    /** 图标触发器的无障碍标题。 */
    title?: string;
    /**
     * 字号档位（AGENTS.md「字号与图标规范」）：
     * - `platform`（默认）：照 GitHub Actions 菜单的实测形态（14px = `--font-lg` 平台对齐档），
     *   用于与平台对齐的命令菜单（看板列/组/条目）；
     * - `ui`：桌面原生下拉按规范走 `--font-md`（12px —— "按钮/输入框/下拉/面板标题"那一档），
     *   行高与之相称（26px）。**新写的、非平台对齐的菜单一律用这一档。**
     */
    size?: "platform" | "ui";
    /**
     * 坐标锚点（右键菜单用）：给定后不渲染触发器，菜单以 `position: fixed` 落在该点。
     * 宿主用 `@close` 清空它——Esc / 外点 / 选中某项都会触发。
     */
    anchor?: { x: number; y: number } | null;
    /** 悬停触发器即展开（平台 Roadmap 行 ▾ 菜单形态），移出 120ms 后收起。 */
    openOnHover?: boolean;
    /** 菜单最小宽度（像素；如平台行菜单的 ~320）。 */
    menuWidth?: number;
    /** 菜单条目行高（像素；缺省 32 = platform 档）。 */
    menuRowHeight?: number;
    /** 菜单与触发器的对齐：right（缺省，菜单右缘对齐触发器右缘）或
     * left（菜单左缘对齐触发器左缘、向右展开——平台行 ▾ 菜单形态）。 */
    align?: "right" | "left";
  }>(),
  { triggerIcon: "", title: "", size: "platform", anchor: null, openOnHover: false, menuWidth: undefined, menuRowHeight: undefined, align: "right" },
);

const emit = defineEmits<{ pick: [value: string]; close: [] }>();

const open = ref(false);
const anchored = computed(() => props.anchor != null);
const menuVisible = computed(() => anchored.value || open.value);
const menuEl = ref<HTMLElement | null>(null);
/** 锚点模式的最终坐标：先贴指针，量出菜单尺寸后越界则上翻 / 左移（VS Code 同款行为）。 */
const anchorCoords = ref<{ left: number; top: number } | null>(null);
const VIEWPORT_MARGIN = 8;

async function placeAnchoredMenu(): Promise<void> {
  const anchor = props.anchor;
  if (!anchor) {
    anchorCoords.value = null;
    return;
  }
  anchorCoords.value = { left: anchor.x, top: anchor.y };
  await nextTick();
  const el = menuEl.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.x;
  let top = anchor.y;
  if (left + rect.width > vw - VIEWPORT_MARGIN) {
    left = Math.max(VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - rect.width);
  }
  if (top + rect.height > vh - VIEWPORT_MARGIN) {
    // 下方不够 → 上翻（以指针下沿对齐菜单底边）；仍不够则贴顶
    top = Math.max(VIEWPORT_MARGIN, anchor.y - rect.height);
  }
  anchorCoords.value = { left, top };
}

watch(
  () => [menuVisible.value, props.anchor?.x, props.anchor?.y],
  () => {
    if (menuVisible.value) void placeAnchoredMenu();
  },
  { immediate: true, flush: "post" },
);
const root = ref<HTMLElement | null>(null);
/** 二级面板（进入时记录其标题与条目；‹ 返回 回到主面板）。 */
const submenu = ref<ActionItem | null>(null);

function toggle() {
  open.value = !open.value;
  submenu.value = null;
  if (open.value) placeMenu();
}
/** 悬停展开（openOnHover）：进入触发器即开，离开 .am 范围 120ms 后收
 * （留出指针从 ▾ 走进菜单的间隙；菜单是 .am 后代，悬停菜单不触发离开）。 */
let hoverTimer: ReturnType<typeof setTimeout> | undefined;
function onHoverEnter() {
  if (!props.openOnHover) return;
  window.clearTimeout(hoverTimer);
  open.value = true;
  submenu.value = null;
  if (open.value) placeMenu();
}
function onHoverLeave() {
  if (!props.openOnHover) return;
  window.clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => closeMenu(), 120);
}
/** 非锚定菜单的自适应高度上限：视口底边 − 触发器下沿 − 余量。
 * 平台形态：面板随内容自适应（无固定上限），真超出视口才内部滚动；
 * 固定 380 上限会让装得下的内容出现无意义的滚动条（且滚轮滚不动多少）。 */
const menuStyle = ref<{ maxHeight: string } | null>(null);
function placeMenu() {
  if (anchored.value) {
    menuStyle.value = null; // 锚定模式已有 calc(100vh − 16px) 兜底
    return;
  }
  const rect = root.value?.getBoundingClientRect();
  if (!rect) return;
  const available = Math.max(120, Math.floor(window.innerHeight - rect.bottom - 8));
  menuStyle.value = { maxHeight: `${available}px` };
}
function closeMenu() {
  open.value = false;
  submenu.value = null;
  if (anchored.value) emit("close");
}
function pick(item: ActionItem) {
  if (item.disabled) return; // 平台的禁用项（如最左列的 Move left）只展示不可点
  if (item.submenu) {
    submenu.value = item;
    return;
  }
  emit("pick", item.value);
  closeMenu();
}
function onDocPointerDown(event: MouseEvent) {
  if (menuVisible.value && root.value && !root.value.contains(event.target as Node)) closeMenu();
}
function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  if (submenu.value) submenu.value = null;
  else closeMenu();
}
onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onKeydown);
  window.clearTimeout(hoverTimer);
});
</script>

<template>
  <div ref="root" class="am" @mouseenter="onHoverEnter" @mouseleave="onHoverLeave">
    <slot v-if="!anchored" name="trigger" :open="open" :toggle="toggle">
      <button
        class="am-trigger"
        type="button"
        :class="{ open }"
        :title="title"
        :aria-expanded="open"
        @click.stop="toggle"
      >
        <EditorIcon v-if="triggerIcon" :name="triggerIcon" />
        <span v-else class="am-trigger-label">{{ title }}</span>
      </button>
    </slot>
    <Teleport to="body" :disabled="!anchored">
      <div
        v-if="menuVisible"
        class="am-menu"
        :class="{ 'am-menu--ui': size === 'ui', 'am-menu--anchored': anchored, 'am-menu--left': align === 'left' }"
        :ref="(el) => (menuEl = el as HTMLElement | null)"
        :style="[
          anchored
            ? (anchorCoords ? { left: `${anchorCoords.left}px`, top: `${anchorCoords.top}px` } : undefined)
            : (menuStyle ?? undefined),
          menuWidth ? { minWidth: `${menuWidth}px` } : null,
          menuRowHeight ? { '--am-row-h': `${menuRowHeight}px` } : null,
        ]"
        role="menu"
      >
      <!-- 二级面板：平台为右侧飞出；桌面按应用既有「‹ 返回」二级面板收口（③适配） -->
      <template v-if="submenu">
        <button class="am-item back" type="button" @click.stop="submenu = null">
          <EditorIcon name="o.arrow-left" />
          <span class="am-label">{{ submenu.label }}</span>
        </button>
        <div class="am-sep"></div>
        <button
          v-for="sub in submenu.submenu"
          :key="sub.value"
          class="am-item"
          type="button"
          role="menuitem"
          :class="{ danger: sub.danger }"
          @click.stop="pick(sub)"
        >
          <EditorIcon v-if="sub.icon" :name="sub.icon" />
          <span class="am-label">{{ sub.label }}</span>
          <span v-if="sub.badge" class="am-badge">{{ sub.badge }}</span>
        </button>
      </template>
      <template v-else>
        <template v-for="(item, i) in items" :key="item.value">
          <!-- 组标题；组名给空串 = 只画分隔线（平台菜单的分段分隔） -->
          <template v-if="item.group !== items[i - 1]?.group">
            <p v-if="item.group" class="am-group">{{ item.group }}</p>
            <div v-else-if="i > 0" class="am-sep"></div>
          </template>
          <div v-else-if="item.dividerBefore" class="am-sep"></div>
          <button
            class="am-item"
            type="button"
            role="menuitem"
            :class="{ danger: item.danger, disabled: item.disabled, first: i === 0 || item.group !== items[i - 1]?.group }"
            @click.stop="pick(item)"
          >
            <EditorIcon v-if="item.icon" :name="item.icon" />
            <span class="am-item-main">
              <span class="am-label">{{ item.label }}</span>
              <span v-if="item.hint" class="am-hint">{{ item.hint }}</span>
            </span>
            <span v-if="item.badge" class="am-badge">{{ item.badge }}</span>
            <EditorIcon v-if="item.submenu && !item.noChevron" class="am-chev" name="o.chevron-right" />
          </button>
        </template>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.am {
  position: relative;
  display: inline-flex;
}
.am-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  height: 22px;
  padding: 0 4px;
  border-radius: 5px;
  cursor: pointer;
}
.am-trigger:hover,
.am-trigger.open {
  color: var(--text);
  background: var(--bg-hover);
}
/* 面板：平台实测圆角 8、通栏分隔线（左右无内边距） */
.am-menu.am-menu--anchored {
  /* 右键菜单：落在指针处。
     注意必须写成两个类：单类 `.am-menu--anchored` 与后面的 `.am-menu` 同特异性，
     会被它后面的 `position: absolute; right: 0` 覆盖 —— 实测就是这样退化成
     "贴在页签条下方"，而树里的菜单还被 `.pane{overflow:hidden}` 裁掉、看起来像"没有菜单"。 */
  position: fixed;
  right: auto;
  top: auto;
  z-index: 200;
  /* 条数多的菜单（知识库树 13 项 ≈ 400px）在 380px 上限下会把尾部条目裁到面板外：
     滚轮没滚到就点，等于点在菜单框外的内容上（实机复现：点「在文件管理器中显示」无反应）。
     桌面右键菜单不该靠滚动——上限放到视口内最大值，越界由上翻逻辑解决。 */
  max-height: calc(100vh - 16px);
}
.am-menu {
  position: absolute;
  top: calc(100% + 3px);
  right: 0;
  z-index: 60;
  min-width: 200px;
  /* 自适应高度：上限由 placeMenu() 按「视口底边 − 触发器下沿」动态给出
     （旧固定 380px 会让装得下的内容出现无意义的滚动条），真超出才内部滚动 */
  overflow-y: auto;
  padding: 4px 0;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
/* 左对齐展开（平台行 ▾ 菜单）：菜单左缘对齐触发器左缘、向右盖过时间轴 */
.am-menu--left {
  left: 0;
  right: auto;
}
.am-sep {
  height: 1px;
  margin: 6px 4px;
  background: var(--border);
}
.am-group {
  margin: 6px 16px 2px;
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--text-dim);
}
.am-group:first-child {
  margin-top: 2px;
}
/* 行：平台实测高 32 / 文本 14 / 行内边距 16；带提示副行的行自适应高度。
   行高可由 menu-row-height 覆盖（如平台行菜单的 40px） */
.am-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-lg);
  font-family: inherit;
  text-align: left;
  min-height: var(--am-row-h, 32px);
  padding: 4px 16px;
  cursor: pointer;
}
/* 禁用项（平台：灰字、无 hover、不可点） */
.am-item.disabled {
  color: var(--text-dim);
  cursor: default;
}
.am-item.disabled:hover {
  background: transparent;
}
.am-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
/* 主列里 label 不再纵向拉伸（.am-label 的 flex:1 是给行内布局推挤 badge/chev 用的） */
.am-item-main .am-label {
  flex: 0 1 auto;
}
.am-hint {
  font-size: var(--font-sm);
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.am-item .editor-icon {
  flex: none;
  color: var(--text-dim);
}
/* ui 档：桌面原生下拉的字号/行高（规范：下拉 = --font-md 12px）。
   platform 档保持 GitHub Actions 菜单实测形态（--font-lg 14px / 32px 行）。 */
.am-menu--ui .am-item {
  font-size: var(--font-md);
  height: 26px;
  padding: 0 14px;
}
.am-menu--ui .am-group {
  /* 组标题保持 --font-md（规范：组头次级 = md），只把左右内边距对齐 ui 档 */
  margin: 6px 14px 2px;
}
.am-menu--ui .am-sep {
  margin: 5px 4px;
}
.am-item:hover {
  background: var(--bg-hover);
}
.am-item.danger .editor-icon {
  color: inherit;
}
.am-item.danger {
  color: var(--danger);
}
.am-item.back {
  color: var(--text-dim);
}
.am-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 快捷键角标：平台实测 20×20 描边小盒 */
.am-badge {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.am-chev {
  flex: none;
  color: var(--text-dim);
}
.am-sep {
  height: 1px;
  margin: 4px 0;
  background: var(--border);
}
</style>
