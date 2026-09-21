<script setup lang="ts">
/**
 * 知识库图谱面板——force-graph 2D（canvas + d3-force）。
 *
 * 设计定案见 KB《架构设计-知识库图谱》：独立 panel（editorCat.knowledge）、
 * 索引 = 派生数据（Rust `kb_graph_index` 一次 IPC 拿全图，不落盘）、
 * 节点点击 → 打开笔记（store.openFile）、度数定大小、顶层文件夹着色。
 * v2（2026-09-19）：记忆布局（app.db prefs，拖拽/收敛后防抖保存，恢复时
 * fx/fy 钉住）；筛选（文件夹多选 + 孤立笔记开关，日历图层菜单同款）；
 * 未建引用虚节点（unresolved → 虚线圆，点击创建文件后整图刷新）。
 * WKWebView 结论：force-graph@1.51.4 + 14 个传递依赖扫描零命中（THIRD-PARTY.md §三）。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import ForceGraph from "force-graph";
import type { NodeObject } from "force-graph";
import PanelShell from "../workbench/PanelShell.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useKnowledgeStore } from "../stores/knowledge";
import { useI18n } from "../i18n";
import { api } from "../api";
import { theme } from "../theme";
import type { KbGraphIndex } from "../api";

defineProps<{ leafId?: string; panelType?: string }>();

// d.ts 把默认导出声明为 class，而 kapsule 运行时是「无 new 的柯里化工厂」：
// 官方 README 即 ForceGraph()(el)——先调一次拿配置链，再传元素挂载。
// 单调用会把元素当配置对象吞掉：不报错、不建 canvas（实机学费，见设计篇 §7）。
type FG = InstanceType<typeof ForceGraph>;
const createGraph = ForceGraph as unknown as () => (el: HTMLElement) => FG;

/** 画布节点：真实笔记 + 未建引用虚节点共用一个形状。 */
interface GraphNodeData {
  id: string;
  title: string;
  folder: string | null;
  /** 标签（真实笔记；虚节点为空）。 */
  tags: string[];
  /** 度数（真实笔记）——force-graph 按面积映射节点大小。 */
  val: number;
  color: string;
  /** 未建引用虚节点（id = ghost:<name>）。 */
  ghost: boolean;
  // 以下由 force-graph / 拖拽维护
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

const knowledge = useKnowledgeStore();
const { t } = useI18n();

const loading = ref(false);
const error = ref<string | null>(null);
const stats = reactive({ nodes: 0, links: 0, unresolved: 0, truncated: false });

const wrapEl = ref<HTMLElement | null>(null);
let fg: FG | null = null;
let ro: ResizeObserver | null = null;

/** 全量数据 + 持久节点对象（筛选换视图不丢坐标）；度数按真实边算。 */
let fullIndex: KbGraphIndex | null = null;
const nodeMap = new Map<string, GraphNodeData>();
const ghostMap = new Map<string, GraphNodeData>();
const degree = new Map<string, number>();

// ---- 筛选（日历图层菜单同款：multiple checkbox DropdownMenu）----

const ORPHAN = "__orphan__";
const GHOST = "__ghost__";
const ROOT_KEY = "__root__";
/** 勾选集：文件夹键 + 标签键（tag: 前缀）+ 两个可见性开关；默认全文件夹、
 * 不筛标签（标签空选 = 不过滤）。 */
const filterSel = ref<string[]>([]);
let filterInitialized = false;
/** 文件夹 / 标签列表（load 时重算；Map 非响应式，列表走 ref 才能驱动菜单）。 */
const folderList = ref<string[]>([]);
const tagList = ref<string[]>([]);

/** 三段分组（文件夹 / 标签 / 可见性）——标签可能几十个，开 filterable 搜索；
 * 空段（如库里还没有任何标签）整段隐藏。 */
const filterSections = computed(() =>
  [
    {
      title: t("graph.folders"),
      options: [
        ...folderList.value.map((f) => ({ value: f, label: f, color: paletteColor(f) })),
        { value: ROOT_KEY, label: t("graph.rootFiles"), color: ROOT_COLOR },
      ],
    },
    {
      title: t("graph.tags"),
      options: tagList.value.map((tag) => ({
        value: `tag:${tag}`,
        label: `#${tag}`,
        color: paletteColor(tag),
      })),
    },
    {
      title: t("graph.visibility"),
      options: [
        { value: ORPHAN, label: t("graph.orphans"), color: "var(--text-dim)" },
        { value: GHOST, label: t("graph.ghosts"), color: "var(--danger)" },
      ],
    },
  ].filter((section) => section.options.length > 0),
);

// ---- 配色 ----

const FOLDER_COLORS = ["#79c0ff", "#7ee787", "#ffa657", "#d2a8ff", "#f778ba", "#56d4dd", "#e3b341", "#ff7b72"];
const ROOT_COLOR = "#8b949e";
/** 标签 / 虚节点描边色（主题切换时刷新）。 */
let labelColor = "#8b949e";
let ghostColor = "#f85149";

function paletteColor(folder: string): string {
  let hash = 0;
  for (const ch of folder) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return FOLDER_COLORS[hash % FOLDER_COLORS.length];
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 主题切换只换线色/字色（节点调色板主题无关），改 accessor 即重绘。 */
function applyThemeColors(): void {
  labelColor = cssVar("--text-dim", "#8b949e");
  ghostColor = cssVar("--danger", "#f85149");
  if (!fg) return;
  fg.linkColor(() => cssVar("--border", "#30363d"));
}

// ---- 数据装载 ----

async function load(): Promise<void> {
  const root = knowledge.root;
  if (!root || loading.value) return;
  loading.value = true;
  error.value = null;
  try {
    const [idx, savedLayout] = await Promise.all([
      api.kbGraphIndex(root),
      api.kbGraphLayoutGet(root).catch(() => null),
    ]);
    stats.nodes = idx.nodes.length;
    stats.links = idx.links.length;
    stats.unresolved = idx.unresolved.length;
    stats.truncated = idx.truncated;
    fullIndex = idx;

    degree.clear();
    for (const l of idx.links) {
      degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
      degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
    }
    const saved = parseLayout(savedLayout);
    nodeMap.clear();
    for (const n of idx.nodes) {
      const node: GraphNodeData = {
        id: n.id,
        title: n.title,
        folder: n.folder,
        tags: n.tags,
        val: 1 + (degree.get(n.id) ?? 0),
        color: n.folder ? paletteColor(n.folder) : ROOT_COLOR,
        ghost: false,
      };
      seedLayout(node, saved.get(n.id));
      nodeMap.set(n.id, node);
    }
    ghostMap.clear();
    for (const name of idx.unresolved) {
      const ghost: GraphNodeData = {
        id: `ghost:${name}`,
        title: name,
        folder: null,
        tags: [],
        val: 1,
        color: labelColor,
        ghost: true,
      };
      seedLayout(ghost, saved.get(`ghost:${name}`));
      ghostMap.set(ghost.id, ghost);
    }
    if (!filterInitialized) {
      folderList.value = [...new Set(idx.nodes.map((n) => n.folder))]
        .filter((f): f is string => f !== null)
        .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
      tagList.value = [...new Set(idx.nodes.flatMap((n) => n.tags))].sort((a, b) =>
        a.localeCompare(b, "zh-Hans-CN"),
      );
      // 默认：全文件夹 + 根目录 + 孤儿 + 未建引用可见；**标签不预选**（空选 = 不筛标签）
      filterSel.value = [...folderList.value, ROOT_KEY, ORPHAN, GHOST];
      filterInitialized = true;
    }
    render();
    applyView();
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

function parseLayout(raw: string | null): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  if (!raw) return out;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    for (const [id, v] of Object.entries(obj)) {
      if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number") {
        out.set(id, [v[0], v[1]]);
      }
    }
  } catch {
    // 布局损坏 → 当作没有，重新力导向排布
  }
  return out;
}

/** 恢复记忆坐标：x/y 给模拟初值，fx/fy 钉住（拖过的节点不再漂移）。 */
function seedLayout(node: GraphNodeData, pos: [number, number] | undefined): void {
  if (!pos) return;
  node.x = pos[0];
  node.y = pos[1];
  node.fx = pos[0];
  node.fy = pos[1];
}

function render(): void {
  disposeGraph();
  if (!wrapEl.value) return;
  fg = createGraph()(wrapEl.value)
    .nodeId("id")
    .nodeVal("val")
    .nodeCanvasObject(drawNode)
    .nodePointerAreaPaint(paintNodeArea)
    .nodeLabel("title")
    .linkWidth(1)
    .onNodeClick(onNodeClick)
    .onNodeDragEnd((node) => {
      // 拖过即钉住（Obsidian 语义），并防抖保存
      node.fx = node.x;
      node.fy = node.y;
      scheduleSave();
    })
    .onEngineStop(() => {
      fg?.zoomToFit(400, 30);
      scheduleSave();
    });
  applyThemeColors();
  resize();
}

function onNodeClick(node: NodeObject): void {
  const data = node as unknown as GraphNodeData;
  if (data.ghost && typeof data.title === "string") {
    void createGhostNote(data.title);
  } else if (typeof data.id === "string") {
    knowledge.openFile(data.id);
  }
}

/** 未建引用虚节点 → 落盘建笔记（嵌套路径逐段建目录），成功后整图刷新。 */
async function createGhostNote(raw: string): Promise<void> {
  const root = knowledge.root;
  if (!root) return;
  try {
    const segs = raw.split("/").filter(Boolean);
    let dir = "";
    for (const seg of segs.slice(0, -1)) {
      dir = dir ? `${dir}/${seg}` : seg;
      await api.kbCreate(root, dir, "dir").catch(() => undefined); // 已存在即继续
    }
    await api.kbCreate(root, `${raw}.md`, "file");
    void load();
  } catch (e) {
    error.value = String(e);
  }
}

// ---- 视图（筛选换 data，节点对象常驻 → 坐标/钉住不丢）----

function applyView(): void {
  if (!fg || !fullIndex) return;
  const sel = new Set(filterSel.value);
  const tagSel = new Set(filterSel.value.filter((v) => v.startsWith("tag:")).map((v) => v.slice(4)));
  const nodes: GraphNodeData[] = [];
  for (const n of nodeMap.values()) {
    const folderOK = sel.has(n.folder ?? ROOT_KEY);
    const orphanOK = (degree.get(n.id) ?? 0) > 0 || sel.has(ORPHAN);
    const tagOK = tagSel.size === 0 || n.tags.some((tag) => tagSel.has(tag));
    if (folderOK && orphanOK && tagOK) nodes.push(n);
  }
  if (sel.has(GHOST)) nodes.push(...ghostMap.values());
  const visible = new Set(nodes.map((n) => n.id));
  const links = fullIndex.links
    .filter((l) => visible.has(l.source) && visible.has(l.target))
    .map((l) => ({ source: l.source, target: l.target }));
  fg.graphData({ nodes: nodes as object[], links });
}

// ---- 自定义节点绘制：实心圆 + 缩放后显标签；虚节点 = 虚线空心圆 ----

const NODE_BASE = 4;

function drawNode(node: NodeObject, ctx: CanvasRenderingContext2D, scale: number): void {
  const n = node as unknown as GraphNodeData;
  const r = Math.sqrt(Math.max(1, n.val)) * NODE_BASE;
  ctx.beginPath();
  ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
  if (n.ghost) {
    ctx.strokeStyle = ghostColor;
    ctx.setLineDash([2.5, 2.5]);
    ctx.lineWidth = 1.2 / Math.max(scale, 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = n.color;
    ctx.fill();
  }
  const showLabel = n.ghost || scale >= 1.1 || n.val >= 4;
  if (showLabel) {
    const fontSize = Math.max(10 / scale, 3);
    ctx.font = `${fontSize}px -apple-system, "PingFang SC", "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = n.ghost ? ghostColor : labelColor;
    ctx.fillText(n.title, n.x ?? 0, (n.y ?? 0) + r + 1.5 / Math.max(scale, 0.5));
  }
}

function paintNodeArea(node: NodeObject, color: string, ctx: CanvasRenderingContext2D): void {
  const n = node as unknown as GraphNodeData;
  const r = Math.sqrt(Math.max(1, n.val)) * NODE_BASE + 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(n.x ?? 0, n.y ?? 0, r, 0, 2 * Math.PI);
  ctx.fill();
}

// ---- 布局保存（防抖）----

let saveTimer: number | undefined;

function scheduleSave(): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveLayout(), 800);
}

async function saveLayout(): Promise<void> {
  const root = knowledge.root;
  if (!root) return;
  const out: Record<string, [number, number]> = {};
  for (const n of nodeMap.values()) {
    if (typeof n.x === "number" && typeof n.y === "number") {
      out[n.id] = [Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10];
    }
  }
  for (const g of ghostMap.values()) {
    if (typeof g.x === "number" && typeof g.y === "number") {
      out[g.id] = [Math.round(g.x * 10) / 10, Math.round(g.y * 10) / 10];
    }
  }
  try {
    await api.kbGraphLayoutSet(root, JSON.stringify(out));
  } catch {
    // 布局记忆是尽力而为：存不进不报错、不打断（下次重排而已）
  }
}

function resize(): void {
  if (!fg || !wrapEl.value) return;
  const rect = wrapEl.value.getBoundingClientRect();
  fg.width(rect.width).height(rect.height);
}

function disposeGraph(): void {
  if (fg) {
    (fg as unknown as { _destructor: () => void })._destructor();
    fg = null;
  }
}

const statsText = computed(() =>
  t("graph.stats", { nodes: String(stats.nodes), links: String(stats.links) }),
);

onMounted(() => {
  void load();
  ro = new ResizeObserver(() => resize());
  if (wrapEl.value) ro.observe(wrapEl.value);
});

onBeforeUnmount(() => {
  window.clearTimeout(saveTimer);
  ro?.disconnect();
  ro = null;
  disposeGraph();
});

watch(
  () => knowledge.root,
  () => {
    filterInitialized = false; // 换根 → 文件夹集合重算，默认回到全开
    void load();
  },
);
watch(theme, () => applyThemeColors());
watch(filterSel, () => applyView());
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template #actions>
      <DropdownMenu v-model="filterSel" multiple checkbox :sections="filterSections" filterable>
        <template #trigger="{ open, toggle }">
          <button class="graph-btn" :class="{ open }" type="button" @click="toggle">
            <EditorIcon name="o.stack" />
            <span>{{ t("graph.filter") }}</span>
          </button>
        </template>
      </DropdownMenu>
      <button
        class="graph-btn"
        type="button"
        :disabled="!knowledge.root || loading"
        @click="load"
      >
        <EditorIcon name="c.refresh" />
        <span>{{ t("graph.refresh") }}</span>
      </button>
    </template>
    <div class="graph-wrap">
      <p v-if="!knowledge.root" class="graph-hint">{{ t("graph.noRoot") }}</p>
      <p v-else-if="error" class="graph-hint">{{ error }}</p>
      <p v-else-if="!loading && stats.nodes === 0" class="graph-hint">{{ t("graph.empty") }}</p>
      <div v-show="knowledge.root && !error" ref="wrapEl" class="graph-canvas"></div>
      <div v-if="knowledge.root && stats.nodes > 0" class="graph-stats">
        <span>{{ statsText }}</span>
        <span v-if="stats.unresolved > 0" :title="t('graph.unresolved', { n: String(stats.unresolved) })">
          · {{ t("graph.unresolved", { n: String(stats.unresolved) }) }}
        </span>
        <span v-if="stats.truncated" class="graph-truncated">{{ t("graph.truncated") }}</span>
      </div>
    </div>
  </PanelShell>
</template>

<style scoped>
.graph-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
}

.graph-btn:hover:not(:disabled),
.graph-btn.open {
  border-color: var(--accent);
  color: var(--accent);
}

.graph-btn:disabled {
  opacity: 0.5;
}

.graph-wrap {
  position: relative;
  height: 100%;
  min-height: 0;
}

.graph-canvas {
  position: absolute;
  inset: 0;
}

.graph-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-md);
  color: var(--text-dim);
}

.graph-stats {
  position: absolute;
  left: 10px;
  bottom: 8px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel);
  font-size: var(--font-sm);
  color: var(--text-dim);
  pointer-events: none;
}

.graph-truncated {
  color: var(--danger);
}
</style>
