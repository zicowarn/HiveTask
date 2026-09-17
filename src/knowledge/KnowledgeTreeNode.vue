<script setup lang="ts">
/**
 * 文件树的一行（递归）。度量照 VS Code 侧栏实测值（见 docs/plan-knowledge-workspace.md §2.1）：
 * 行高 22px、箭头单元格 16px、缩进步长 8px（容器自 16px 起）、缩进参考线 1px、
 * 图标 16×16 配 22px 行高、行左内边距 2px。
 *
 * 颜色不照抄 VS Code 调色板，映射到本仓库既有 token（③适配：与工作区其它面板统一）。
 */
import { computed } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useKnowledgeStore } from "../stores/knowledge";
import { iconForEntry } from "./file-icon";
import { dragPaths, dropBefore, dropDir, suppressClick } from "./tree-drag";
import type { KbEntry } from "../api";

const props = defineProps<{ entry: KbEntry; depth: number }>();
const store = useKnowledgeStore();

const emit = defineEmits<{
  /** 右键某一行：把条目与屏幕坐标交给宿主渲染菜单。 */
  menu: [payload: { entry: KbEntry; x: number; y: number }];
  /** 指针按下（拖拽候选）：由宿主统一编排拖拽（HTML5 拖放会被 Tauri 吞掉）。 */
  dragStart: [payload: { rel: string; event: PointerEvent }];
  /** 点行时把键盘焦点交给树容器（键盘导航的作用对象）。 */
  focusTree: [];
}>();

/**
 * 缩进度量（用户口径）：行首基准 **8px**、每级 8px。
 *
 * 与 VS Code 的差异（③适配）：那里是 2px 行内边距 + 16px 箭头格 = 18px 基准；
 * 我们的树栏只有 ≈294px 宽，18px 的空白占比过大，收到 8px 让标签多出 10px。
 * 箭头格宽度保持 16px、**去掉 VS Code 那 3px 位移**——否则箭头与缩进参考线会错开 3px。
 */
const TREE_INSET = 8;
const INDENT_STEP = 8;

const isDir = computed(() => props.entry.kind === "dir");
/** 过滤态下：含命中后代的目录强制展开；否则用用户自己的展开状态。 */
const open = computed(() =>
  store.filter ? store.hasMatchInside(props.entry.rel) : !!store.expanded[props.entry.rel],
);
const kids = computed(() => store.visibleChildren(props.entry.rel));
const active = computed(() => store.selected === props.entry.rel);
/** 多选：这一行在选中集里（与"当前打开"分开，VS Code 也是两层视觉）。 */
const selected = computed(() => store.isSelected(props.entry.rel));
/** 键盘焦点行（与"当前打开"、"选中集"都不是一回事）。 */
const focused = computed(() => store.focusRel === props.entry.rel);
/** 拖拽落点反馈：整行高亮（目录）或插入线（落到某文件所在目录）。 */
const isDropTarget = computed(() => dropDir.value === props.entry.rel && dragPaths.value.length > 0);
const dropBeforeHere = computed(() => dropBefore.value === props.entry.rel);
const dragging = computed(() => dragPaths.value.includes(props.entry.rel));

/** 图标：目录按开合切换，文件按**类别**给（见 file-icon.ts 的说明）。 */
const icon = computed(() => iconForEntry(props.entry, open.value));

function click(event: MouseEvent): void {
  // 真拖过之后紧随的这次 click 要吃掉，否则拖完会顺手打开文件/折叠目录
  if (suppressClick.value) return;
  const rel = props.entry.rel;
  // ⌘/Ctrl = 加选；Shift = 范围选（都按"可见行"顺序）；普通点击 = 单选 + 打开。
  // 加选/范围选**不切预览**（VS Code 同款）：否则"当前打开"会在选中项之间乱跳，
  // 多选里就混进另一种高亮，看起来像没选上。
  if (event.metaKey || event.ctrlKey) {
    store.toggleSelection(rel);
    return;
  }
  if (event.shiftKey) {
    store.selectRange(rel);
    return;
  }
  store.selectOnly(rel);
  if (isDir.value) {
    void store.toggleDir(rel);
    return;
  }
  store.select(rel);
}
</script>

<template>
  <div>
    <div
      class="row"
      :class="{
        active,
        selected,
        ignored: entry.ignored,
        focused,
        'drop-target': isDropTarget,
        'drop-before': dropBeforeHere,
        dragging,
      }"
      :style="{ paddingLeft: `${TREE_INSET + depth * INDENT_STEP}px` }"
      role="treeitem"
      :data-rel="entry.rel"
      :data-kind="entry.kind"
      :aria-expanded="isDir ? open : undefined"
      :aria-selected="active"
      :title="entry.name"
      @click="click"
      @pointerdown="emit('dragStart', { rel: entry.rel, event: $event }); emit('focusTree')"
      @contextmenu.prevent.stop="emit('menu', { entry, x: $event.clientX, y: $event.clientY })"
    >
      <div v-if="depth > 0" class="guides" :style="{ width: `${depth * INDENT_STEP}px` }" />
      <span class="twistie" :class="{ empty: !isDir }">
        <EditorIcon v-if="isDir" :name="open ? 'o.chevron-down' : 'o.chevron-right'" />
      </span>
      <EditorIcon class="ficon" :name="icon" />
      <span class="label">{{ entry.name }}</span>
    </div>

    <template v-if="isDir && open">
      <KnowledgeTreeNode
        v-for="child in kids"
        :key="child.rel"
        :entry="child"
        :depth="depth + 1"
        @drag-start="emit('dragStart', $event)"
        @focus-tree="emit('focusTree')"
        @menu="emit('menu', $event)"
      />
    </template>
  </div>
</template>

<style scoped>
.row {
  position: relative;
  display: flex;
  align-items: center;
  height: 22px;
  line-height: 22px;
  /* 列表主文本档（与 IssueRow 同档；VS Code 资源管理器同为 13px） */
  font-size: var(--font-base);
  color: var(--text);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
}
.row:hover {
  background: var(--bg-hover);
}
/*
 * 拖拽进行中**关掉悬停底色**：否则拖着扫过哪些行、哪些行就亮一下，
 * 看起来像"一路点选过去"——真正的落点反馈只有 drop-target / drop-before 两个。
 */
:global(body.tree-dragging) .row:hover {
  background: transparent;
}
/*
 * 选中态**只有一种外观**（VS Code 语义）：所有被选中的行长得一模一样，
 * 选中集里不会混着"另一种高亮"。当前打开的那一项只在**它没被选中时**
 * 才用 `.row.active` 单独标出来（这样"打开的是哪个文件"始终看得见）。
 * ⚠️ 规则必须写在本组件：`.row` 是这里渲染的，挂在 KnowledgeTree 的 scoped
 * 样式下编译后一条都匹配不到（踩过）。
 */
.row.selected {
  background: var(--bg-selected);
}
/* 选中的同时又是当前打开项 → 与其它选中行保持一致，不叠加深色 */
.row.selected.active {
  background: var(--bg-selected);
}
/* 拖拽落点：目录整行高亮；落到"某文件所在目录"时在该行上方画插入线（VS Code 同款） */
/* 键盘焦点环：只在树**真的拿到键盘焦点**时显示（`:focus-within`），
   否则鼠标操作后也会一直挂着一个圈，像没点干净 */
:global(.tree-body:focus-within) .row.focused {
  box-shadow: inset 0 0 0 1px var(--accent);
}
.row.drop-target {
  background: var(--bg-hover);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.row.drop-before {
  box-shadow: inset 0 2px 0 0 var(--accent);
}
.row.dragging {
  opacity: 0.55;
}
.row.active:not(.selected) {
  background: color-mix(in srgb, var(--bg-selected) 60%, transparent);
}
/* gitignore 命中：灰显（VS Code 也是「不隐藏、只弱化」） */
.row.ignored .label,
.row.ignored .ficon {
  opacity: 0.55;
}
/* 缩进参考线：与祖先行的箭头列同 x（行首基准 8px，每级 8px），线宽 1px。 */
.guides {
  position: absolute;
  left: 8px;
  top: 0;
  bottom: 0;
  pointer-events: none;
  background-image: repeating-linear-gradient(
    90deg,
    var(--border) 0 1px,
    transparent 1px 8px
  );
}
.twistie {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 22px;
  color: var(--text-dim);
}
/* 目录才有箭头；文件位置留白，保证同级名称对齐 */
.twistie.empty {
  visibility: hidden;
}
.ficon {
  flex: none;
  /* 与折叠箭头之间留出间隙（原先紧贴，实机反馈偏挤） */
  margin-left: 3px;
  margin-right: 6px;
  color: var(--text-dim);
}
.row.active .ficon {
  color: inherit;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
