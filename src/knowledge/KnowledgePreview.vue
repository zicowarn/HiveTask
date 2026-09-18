<script setup lang="ts">
/**
 * 预览 / 编辑宿主（右栏）。
 *
 * 本阶段（S1）只做**只读预览**：图片走字节流 + object URL，文本 / Markdown 走
 * 解码后的文本；其余格式给"暂不支持预览"的诚实卡片 + 两个真实出口
 * （默认应用打开 / 在文件管理器中显示）——不摆空控件。
 *
 * S2 起：`.md` 换成本仓库的 CM6 live-preview 编辑器（届时本组件只负责分派）。
 */
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import EditorIcon from "../components/EditorIcon.vue";

import { api, isTauri, type KbText } from "../api";
import { useI18n } from "../i18n";
import ActionMenu, { type ActionItem } from "../components/ActionMenu.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import MarkdownToolbar from "../components/MarkdownToolbar.vue";
import SplitPane from "../workbench/SplitPane.vue";
import KnowledgeOutline from "./KnowledgeOutline.vue";
import KnowledgeFindBar from "./KnowledgeFindBar.vue";
import KnowledgeConvertDialog from "./KnowledgeConvertDialog.vue";
import { activeOutlineIndex, type OutlineItem } from "./editor/outline";
import { EDITOR_COMMAND_GROUPS } from "../components/markdown-tools";
import { CONTEXT_MENU_GROUPS } from "./editor/commands";
import { commandByKey } from "../components/markdown-tools";
import { pushToast } from "../toast";
import { confirmAction } from "../confirm";
import { resolvePreview } from "./preview/registry";
import "./preview"; // 注册各格式插件（副作用导入）
import {
  formatLabelKey,
  imageMimeFor,
  looksLikeText,
  previewKind,
  TEXT_FALLBACK_MAX_BYTES,
  type PreviewKind,
} from "./preview/kind";
import { ZoomController, type Size } from "./preview/zoom";
import type { ZoomAction } from "./preview/registry";
import { useKnowledgeStore } from "../stores/knowledge";
import { openPathWithConfiguredApp, revealPath } from "./open-path";

const props = defineProps<{ reloadTick?: number }>();

const emit = defineEmits<{
  /** 面包屑点击：在文件树中展开并定位到该路径（目录或文件）。 */
  "reveal-in-tree": [rel: string];
}>();

/**
 * 编辑器按需加载：CM6 + KaTeX + Mermaid 合计约 1MB（未压缩），
 * 静态引入会把它们塞进启动包——不打开 Markdown 的用户不该付这份代价。
 */
const MarkdownEditor = defineAsyncComponent(() => import("./editor/MarkdownEditor.vue"));

const store = useKnowledgeStore();
const { t } = useI18n();

/** 非 Markdown / 非图片一律交给预览注册表（PDF / Office / OFD / 媒体 / 3D / CAD…）。 */
const previewHost = ref<HTMLElement | null>(null);
/** 内容区（图片缩放要按它的尺寸算"适应窗口"）。 */
const bodyEl = ref<HTMLElement | null>(null);
let previewInstance: import("./preview/registry").PreviewInstance | null = null;

const text = ref<KbText | null>(null);
/** Markdown 编辑缓冲：CM6 的文档即源文本；改动先落这里，保存走 ⌘S（T7）。 */
const mdDraft = ref("");
const mdDirty = ref(false);
const saving = ref(false);
/** 磁盘上的文件已被外部改动（保存时 mtime 不符）——弹冲突条让用户选，而不是只丢一句错误。 */
const conflict = ref(false);
/** 注册表里没有插件认领（显示"暂不支持 + 用默认应用打开"的诚实卡片）。 */
const unsupported = ref(false);
const resolvedPluginId = ref<string | null>(null);
const imageUrl = ref<string | null>(null);
/** 没有内置渲染器时，用系统生成的预览图兜底（Quick Look；拿不到就不显示）。 */
const systemPosterUrl = ref<string | null>(null);

/**
 * 当前编码（头部按钮与菜单打勾都用它）。
 *
 * 取 `store.activeText` 而不是 `text.value`：注册表渲染的格式（csv/代码…）在面板里
 * `text.value` 只是"元信息空壳"（encoding 为空），真实编码由插件读文本时回灌到 store ——
 * 用 text.value 会让头部按钮**根本不出现**（与状态栏那格同源的一次踩坑）。
 */
const currentEncoding = computed(() => store.activeText?.encoding ?? "");

/**
 * 面包屑：把 rel 拆成「目录 › 子目录 › 文件名」，每段可点。
 * 点击 = 在文件树中展开定位到该段（复用既有 reveal-in-tree 通道，页签右键同款）。
 */
const breadcrumbSegments = computed(() => {
  const target = rel.value;
  if (!target) return [];
  const parts = target.split("/");
  const segments: { name: string; path: string; isFile: boolean }[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    segments.push({
      name: parts[i],
      path: parts.slice(0, i + 1).join("/"),
      isFile: i === parts.length - 1,
    });
  }
  return segments;
});
/** 标签把 BOM 折进来（VS Code 的 "UTF-8 with BOM" 同义），省掉一个重复 chip。 */
const encodingLabel = computed(() => {
  const encoding = currentEncoding.value;
  if (!encoding) return "";
  return store.activeText?.bom ? `${encoding}·BOM` : encoding;
});

/** 候选编码：与状态栏同一份清单（ICU 规范名，与 Rust 返回的一致）。 */
const ENCODING_CHOICES = ["UTF-8", "GBK", "GB18030", "BIG5", "Shift_JIS", "EUC-KR", "UTF-16LE", "UTF-16BE"];
/**
 * 用户在状态栏手动指定的编码（`null` = 自动探测）。
 *
 * 必须**绑定到具体文件**：否则切到下一个文件时会把上一个文件的手动编码带过去
 * （用户切了 GBK，下一个 UTF-8 文件就被按 GBK 解码成乱码）。
 */
let forcedEncoding: { rel: string; encoding: string } | null = null;
const imageEl = ref<HTMLImageElement | null>(null);
/**
 * 缩放：面板只做两件事 —— 记状态、把动作转给"当前持有画面的那一方"。
 * 图片由面板自己缩放（它在面板分支里渲染），其余格式由插件实现（声明 `tools: ["zoom"]`）。
 */
interface ZoomState {
  percent: number;
  fit: boolean;
  /** 正处在哪个「适应」口径（菜单打勾用）。 */
  mode?: "width" | "page" | null;
}
const zoom = ref<ZoomState | null>(null);
const pluginTools = ref<string[]>([]);
/** 在线底图是否已打开（只有声明了 basemap 工具的格式用得到）。 */
const basemapOn = ref(false);
const zoomSupported = computed(() => kind.value === "image" || pluginTools.value.includes("zoom"));
/** 该格式的「适应」口径（两个时面板把"适应"做成下拉）。 */
const zoomModes = computed<("width" | "page")[]>(() => (kind.value === "image" ? ["page"] : pluginZoomModes.value));
const pluginZoomModes = ref<("width" | "page")[]>([]);
const zoomMenuOpen = ref(false);

/** 「适应」菜单项：文档类给两种口径，并在当前口径上打勾。 */
const zoomFitItems = computed(() =>
  zoomModes.value.map((mode) => ({
    value: mode,
    label: mode === "width" ? t("kb.zoomFitWidth") : t("kb.zoomFitPage"),
  })),
);

function pickFitMode(id: string): void {
  zoomMenuOpen.value = false;
  onZoomAction(id === "width" ? "fit-width" : "fit-page");
}
const loading = ref(false);
const error = ref<string | null>(null);

const rel = computed(() => store.selected);
const name = computed(() => rel.value?.split("/").pop() ?? "");
const ext = computed(() => (name.value.includes(".") ? name.value.split(".").pop()!.toLowerCase() : ""));
/** 注册表认领不了、但内容判定为文本 → 显示为纯文本（见 kind.ts）。 */
const textFallback = ref(false);
const kind = computed<PreviewKind>(() => {
  if (!rel.value) return "other";
  return previewKind(ext.value, textFallback.value);
});

const absPath = computed(() => (store.root && rel.value ? `${store.root}/${rel.value}` : ""));

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 取系统预览图（拿不到就静默 —— 卡片本身已经说明了情况）。 */
async function loadSystemPoster(base: string, target: string): Promise<void> {
  releaseSystemPoster();
  try {
    const png = await api.kbThumbnail(base, target);
    if (!png) return;
    systemPosterUrl.value = URL.createObjectURL(new Blob([png], { type: "image/png" }));
  } catch {
    // 系统没有这个格式的预览器 → 保持不显示
  }
}

function releaseSystemPoster(): void {
  if (systemPosterUrl.value) URL.revokeObjectURL(systemPosterUrl.value);
  systemPosterUrl.value = null;
}

function releaseImage(): void {
  if (imageUrl.value) {
    URL.revokeObjectURL(imageUrl.value);
    imageUrl.value = null;
  }
}

const editorRef = ref<{
  runCommand: (command: { kind: string; key: string }) => boolean;
  goToLine: (line: number) => void;
  setFindQuery: (config: { search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }) => void;
  clearFindQuery: () => void;
  findNext: () => void;
  findPrevious: () => void;
  replaceNext: () => void;
  replaceAllMatches: () => void;
  findStatus: () => { total: number; current: number };
} | null>(null);

// ---- 查找/替换条（自绘，叠在编辑区右上）----
const findOpen = ref(false);
const findBarRef = ref<{ setStatus: (status: { total: number; current: number }) => void; focus: () => void } | null>(null);

function openFind(): void {
  findOpen.value = true;
  void nextTick(() => findBarRef.value?.focus());
}

function closeFind(): void {
  findOpen.value = false;
  editorRef.value?.clearFindQuery(); // 关掉即撤高亮，避免"看不见的命中"残留
  previewInstance?.findClear?.();
}

/** 当前预览是否由插件提供查找（PDF 这类"画在 canvas 上"的格式）。 */
const pluginFind = computed(() => pluginTools.value.includes("find"));

function onFindQuery(config: { search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }): void {
  if (pluginFind.value) {
    lastFindQuery.value = config.search;
    lastFindCase.value = config.caseSensitive;
    lastFindRegexp.value = config.regexp;
    lastFindWholeWord.value = config.wholeWord;
    void runPluginFind(config.search, {
      forward: true,
      caseSensitive: config.caseSensitive,
      regexp: config.regexp,
      wholeWord: config.wholeWord,
    });
    return;
  }
  editorRef.value?.setFindQuery(config);
  syncFindStatus();
}

/** 插件侧查找：命中数与当前序号由插件回报（首次会建索引，所以是异步的）。 */
async function runPluginFind(
  query: string,
  options: { forward: boolean; caseSensitive?: boolean; regexp?: boolean; wholeWord?: boolean },
): Promise<void> {
  const find = previewInstance?.find;
  if (!find) return;
  const result = await find.call(previewInstance, query, options);
  findBarRef.value?.setStatus(result);
}

function stepPluginFind(forward: boolean): void {
  const bar = findBarRef.value;
  void bar;
  const lastQuery = lastFindQuery.value;
  if (!lastQuery) return;
  void runPluginFind(lastQuery, {
    forward,
    caseSensitive: lastFindCase.value,
    regexp: lastFindRegexp.value,
    wholeWord: lastFindWholeWord.value,
  });
}

const lastFindQuery = ref("");
const lastFindCase = ref(false);
const lastFindRegexp = ref(false);
const lastFindWholeWord = ref(false);

/** 每次查询或跳转后回报命中数（与高亮同一份查询状态）。 */
function syncFindStatus(): void {
  void nextTick(() => {
    const status = editorRef.value?.findStatus();
    if (status) findBarRef.value?.setStatus(status);
  });
}

function onEditorFindKey(): void {
  openFind();
}

// ---- 视图开关（大纲 / 源码模式），与编辑器比例一起记住 ----
const VIEW_KEY = "hivetask.kb.view";
const editorRatio = ref(0.72);

function loadView(): { outlineOpen: boolean; livePreview: boolean; editorRatio: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as Record<string, unknown>;
    return {
      outlineOpen: raw.outlineOpen === true,
      livePreview: raw.livePreview !== false,
      editorRatio: typeof raw.editorRatio === "number" && raw.editorRatio > 0.35 && raw.editorRatio < 0.95 ? raw.editorRatio : 0.72,
    };
  } catch {
    return { outlineOpen: false, livePreview: true, editorRatio: 0.72 };
  }
}
const savedView = loadView();
const outlineOpen = ref(savedView.outlineOpen);
const livePreview = ref(savedView.livePreview);
editorRatio.value = savedView.editorRatio;

function persistView(): void {
  try {
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({ outlineOpen: outlineOpen.value, livePreview: livePreview.value, editorRatio: editorRatio.value }),
    );
  } catch {
    // 存储不可用 → 本次会话内仍生效
  }
}

function toggleOutline(): void {
  outlineOpen.value = !outlineOpen.value;
  persistView();
}

function toggleSourceMode(): void {
  livePreview.value = !livePreview.value;
  persistView();
}

/** 由页签菜单的「重新打开方式」调用（与头部开关同源）。 */
function setViewMode(value: "rich" | "source"): void {
  livePreview.value = value === "rich";
  persistView();
}

function persistEditorRatio(value: number): void {
  editorRatio.value = value;
  persistView();
}

// ---- 大纲数据与"当前章节" ----
/** 插件给的大纲（PDF 书签）：转成侧栏要的形状，`line` 里放跳转目标（页码）。 */
const pluginOutline = ref<OutlineItem[]>([]);
/** 有结构（大纲）的格式才配侧栏；显隐由大纲按钮控制。 */
const showPluginOutline = computed(() => outlineOpen.value && pluginOutline.value.length > 0);
/**
 * 插件大纲的"当前章节"：取最后一条页码不超过当前页的条目。
 * 有了它，跳转的效果在侧栏上也能看出来（不再只靠画面滚动）。
 */
const pluginOutlineActiveIndex = computed(() => {
  const page = store.paging?.page ?? 0;
  if (!page) return -1;
  let active = -1;
  pluginOutline.value.forEach((item, index) => {
    if (item.line > 0 && item.line <= page) active = index;
  });
  return active;
});
const outlineItems = computed<OutlineItem[]>(() => (pluginOutline.value.length ? pluginOutline.value : editorOutline.value));
const editorOutline = ref<OutlineItem[]>([]);
const activeHeadingIndex = computed(() =>
  activeOutlineIndex(outlineItems.value, store.cursor ? store.cursor.line - 1 : null),
);

function jumpToLine(line: number): void {
  if (pluginOutline.value.length) {
    // target = 0 表示这份书签没解析出页码（点它不该跳去别的地方）
    if (line > 0) previewInstance?.reveal?.(line);
    return;
  }
  editorRef.value?.goToLine(line);
}

/** 面板头工具条：命令表 → 编辑器。 */
function runEditorCommand(command: { kind: string; key: string }): void {
  editorRef.value?.runCommand(command as never);
}

/**
 * 文件级动作：**留在右键菜单**（VS Code 也是这么放的：资源管理器右键文件 → Reveal in Finder）。
 * 头部只保留主操作「默认应用打开」为可见按钮——两个都折叠进 ⋯ 会把菜单变成单选项，
 * 只折叠其中一个也同样是单选项，所以干脆让这一层不存在。
 */
const FILE_ACTIONS: ActionItem[] = [
  { value: "open", label: t("kb.openWithDefault"), icon: "o.link-external" },
  { value: "reveal", label: t("kb.revealInFinder"), icon: "o.file-directory" },
];

function runFileAction(value: string): void {
  if (value === "open") void openDefault();
  if (value === "reveal") void reveal();
}

// ---- 右键菜单（与工具条同一份命令表）----
const contextMenu = ref<{ x: number; y: number } | null>(null);

function openContextMenu(payload: { x: number; y: number }): void {
  contextMenu.value = payload;
}

const contextItems = computed<ActionItem[]>(() => {
  const commands = CONTEXT_MENU_GROUPS.flatMap((group, index) =>
    group
      .map((key) => commandByKey(key))
      .filter((command): command is NonNullable<typeof command> => !!command)
      .map((command) => ({
        value: command.key,
        label: t(command.labelKey),
        icon: command.icon,
        badge: command.shortcut,
        // 每组之间画一条分隔线（与工具条的竖线分组同源）
        dividerBefore: index > 0 && group[0] === command.key,
      })),
  );
  // 末尾追加文件动作组（与头部按钮同源；此处是"就地"入口）
  return [
    ...commands,
    ...FILE_ACTIONS.map((item, index) => ({ ...item, dividerBefore: index === 0 })),
  ];
});

function onContextPick(value: string): void {
  const command = commandByKey(value);
  if (command) {
    editorRef.value?.runCommand(command as never);
  } else {
    runFileAction(value);
  }
  contextMenu.value = null;
}

/** 用注册表渲染非 Markdown 文件；没有插件认领时保留"暂不支持"卡片（previewFailed）。 */
async function renderViaRegistry(base: string, target: string, size: number, forced?: string): Promise<void> {
  const name = target.split("/").pop() ?? target;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const readBytes = async (): Promise<Uint8Array> =>
    new Uint8Array(await api.kbReadBytes(base, target));
  await nextTick();
  const container = previewHost.value;
  if (!container) return;
  const resolved = await resolvePreview({ root: base, rel: target, name, ext }, readBytes);
  if (!resolved) {
    // 没有插件认领：先试系统预览图（Pages/Numbers/Keynote、sketch 之类系统能画）
    void loadSystemPoster(base, target);
    // 没有插件认领：是文本就给纯文本视图（无扩展名的 README/Makefile/.env 这类），
    // 是二进制才给"暂不支持 + 用默认应用打开"的卡片——不拿乱码糊弄人
    if (size <= TEXT_FALLBACK_MAX_BYTES) {
      const loaded = await api.kbReadText(base, target);
      if (looksLikeText(loaded.text.slice(0, 4096))) {
        text.value = loaded;
        textFallback.value = true;
        return;
      }
    }
    unsupported.value = true;
    return;
  }
  unsupported.value = false;
  resolvedPluginId.value = resolved.id;
  pluginTools.value = resolved.plugin.tools ?? [];
  pluginZoomModes.value = resolved.plugin.zoomModes ?? ["page"];
  const formatKey = formatLabelKey(ext, kind.value, resolved.id);
  if (formatKey) store.setActiveFormat({ label: t(formatKey as Parameters<typeof t>[0]), size });
  previewInstance?.destroy?.();
  const instance = await resolved.plugin.render({
    root: base,
    rel: target,
    name,
    ext,
    container,
    readBytes,
    // 带上手动编码：文本类插件（text/代码…）就是靠这条路径读内容的。
    // 顺带把**真实元信息回灌给状态栏**：否则 kind === "other" 下 activeText 只是空壳
    // （encoding 为空），编码格 `v-if="knowledge.activeText"` 直接不渲染 ——
    // 用户就没有可点的编码切换入口（实测"没有实现"）。
    readText: async () => {
      const loaded = await api.kbReadText(base, target, forced);
      store.setActiveText(loaded);
      return loaded.text;
    },
    // 同根内其它文件（HLS 分片、3D 的 .bin、shp 的配套 .dbf）：同样受 Rust 侧根沙箱约束
    readSibling: async (sibling: string) => new Uint8Array(await api.kbReadBytes(base, sibling)),
    // 系统预览图（Quick Look）：媒体解不了、或格式没有内置渲染器时用它兜底
    systemThumbnail: async () => {
      const png = await api.kbThumbnail(base, target);
      return png ? new Uint8Array(png) : null;
    },
    theme: "dark",
    onZoom: (state) => {
      zoom.value = state;
    },
    onPaging: (state) => {
      store.setPaging(state);
    },
    onSection: (title) => {
      store.setSection(title);
    },
    onInfo: (text) => {
      store.setPreviewInfo(text);
    },
    onBasemap: (on) => {
      basemapOn.value = on;
    },
  });
  previewInstance = instance ?? null;
  pluginOutline.value = (instance?.outline ?? []).map((item) => ({
    level: item.level,
    text: item.title,
    line: item.target,
  }));
}

function onEditorInput(value: string): void {
  mdDraft.value = value;
  mdDirty.value = true;
  const target = rel.value;
  const meta = text.value;
  if (target && meta) store.setBuffer(target, { text: value, meta, dirty: true });
}

/** ⌘S / Ctrl+S：按原编码回写；外部改动过则拒绝并提示。 */
async function saveDraft(): Promise<void> {
  const base = store.root;
  const target = rel.value;
  const meta = text.value;
  if (!base || !target || !meta || !mdDirty.value) return;
  saving.value = true;
  try {
    const mtime = await api.kbWriteText({
      root: base,
      rel: target,
      text: mdDraft.value,
      encoding: meta.encoding,
      bom: meta.bom,
      eol: meta.eol,
      expectedMtimeMs: meta.mtimeMs,
    });
    text.value = { ...meta, text: mdDraft.value, mtimeMs: mtime };
    store.setActiveText(text.value);
    mdDirty.value = false;
    store.setBuffer(target, { text: mdDraft.value, meta: text.value, dirty: false });
    pushToast({ kind: "success", message: t("kb.saved") }, 2500);
  } catch (e) {
    const message = String(e);
    // 后端按"mtime 不符"拒绝覆盖 → 走冲突流程（重新载入 / 强制保存），不把它当成普通错误
    if (message.includes("已被外部修改")) {
      conflict.value = true;
    } else {
      error.value = message;
    }
  } finally {
    saving.value = false;
  }
}

/** 冲突处理 A：放弃本地编辑，重新读磁盘。 */
async function reloadFromDisk(): Promise<void> {
  const target = rel.value;
  conflict.value = false;
  mdDirty.value = false;
  if (target) store.dropBuffer(target);
  await load();
}

/** 冲突处理 B：以本地内容覆盖（显式忽略 mtime 校验）。 */
async function saveForced(): Promise<void> {
  const base = store.root;
  const target = rel.value;
  const meta = text.value;
  if (!base || !target || !meta) return;
  saving.value = true;
  try {
    const mtime = await api.kbWriteText({
      root: base,
      rel: target,
      text: mdDraft.value,
      encoding: meta.encoding,
      bom: meta.bom,
      eol: meta.eol,
      expectedMtimeMs: null, // 用户已确认覆盖
    });
    text.value = { ...meta, text: mdDraft.value, mtimeMs: mtime };
    store.setActiveText(text.value);
    store.setBuffer(target, { text: mdDraft.value, meta: text.value, dirty: false });
    mdDirty.value = false;
    conflict.value = false;
    pushToast({ kind: "success", message: t("kb.saved") }, 2500);
  } catch (e) {
    error.value = String(e);
  } finally {
    saving.value = false;
  }
}

/**
 * 搜索命中点击 → 跳到那一行。
 *
 * 三个条件齐了才跳：目标还在、文件已切过来、编辑器已挂载（CM6 是异步组件）。
 * 差一个就等着 —— 早期的写法在"文件还没切过来"时直接清掉了请求，结果跳转丢失。
 * 文本回退视图（`<pre>`）没有编辑器，按行高滚动到大致位置；其余格式（PDF/图片…）
 * 只打开文件（它们没有"行"的概念）。
 */
watch([rel, () => store.jumpToLine, editorRef], async () => {
  const target = store.jumpToLine;
  if (!target || rel.value !== target.rel) return;
  if (kind.value === "markdown" && !editorRef.value) return;
  store.clearJump();
  await nextTick();
  if (kind.value === "markdown") {
    editorRef.value?.goToLine(target.line);
    return;
  }
  const pre = bodyEl.value?.querySelector<HTMLElement>("pre.code");
  if (pre) {
    const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight || "0") || 20;
    pre.scrollTop = Math.max(0, (target.line - 3) * lineHeight);
  }
});

/**
 * 状态栏切换编码 → 按指定编码重新解码当前文件。
 *
 * 三个来源的动作都落到这里：状态栏的 DropdownMenu、（未来的）菜单项。
 * Markdown 有未保存改动时先确认 —— 重读会覆盖草稿；确认文案把后果说清。
 * 重新读到的 `meta.encoding` 就是用户选的编码，⌘S 保存链路会按它回写（= 转码另存）。
 */
watch(
  () => store.encodingRequest,
  async (encoding) => {
    const base = store.root;
    const target = rel.value;
    if (!encoding || !base || !target) return;
    if (kind.value === "markdown" && mdDirty.value) {
      const ok = await confirmAction(t("kb.encodingReloadDirty"), {
        title: t("kb.encodingSwitch"),
        okLabel: t("kb.encodingReloadOk"),
        cancelLabel: t("common.cancel"),
      });
      if (!ok) {
        store.clearEncodingRequest();
        return;
      }
    }
    store.clearEncodingRequest();
    // 记下手动编码并**走完整的 load()**：`.txt`/代码这类由注册表插件渲染的内容
    // 只在 load() → renderViaRegistry 这条链上重画；只更新 text.value 会让
    // 状态栏编码变了、画面却纹丝不动（用户实测"没有实现"）。
    forcedEncoding = { rel: target, encoding };
    store.dropBuffer(target);
    mdDirty.value = false;
    await load();
    pushToast(
      {
        kind: "success",
        message: t("kb.encodingSwitched", { encoding: store.activeText?.encoding ?? encoding }),
      },
      2500,
    );
  },
);

// ---- 编码菜单（头部）：改解读方式 / 转换另存为 ----
const encodingMenu = ref<{ x: number; y: number } | null>(null);
const convertOpen = ref(false);

const encodingMenuItems = computed<ActionItem[]>(() => {
  type Key = Parameters<typeof t>[0];
  const current = currentEncoding.value;
  const items: ActionItem[] = [];
  // ① 以此编码重新打开（与状态栏那格同源；当前编码带勾）
  items.push({ value: "default", label: t("kb.encodingAuto" as Key), icon: "o.refresh", group: t("kb.encodingReopenGroup" as Key) });
  for (const name of ENCODING_CHOICES) {
    items.push({
      value: `enc:${name}`,
      label: name,
      badge: name === current ? "✓" : undefined,
    });
  }
  // ② 转换（写出新文件）
  items.push({ value: "convert", label: t("kb.convertAs" as Key), icon: "o.download", group: t("kb.convertTitle" as Key) });
  return items;
});

function openEncodingMenu(event: MouseEvent): void {
  encodingMenu.value = { x: event.clientX, y: event.clientY };
}

async function onEncodingMenuPick(value: string): Promise<void> {
  encodingMenu.value = null;
  if (value === "convert") {
    convertOpen.value = true;
    return;
  }
  if (value === "default") {
    // 回到自动探测：清掉手动编码后重读
    forcedEncoding = null;
    await load();
    return;
  }
  if (value.startsWith("enc:")) {
    store.requestEncoding(value.slice(4));
  }
}

/** 转换对话框要的文本：Markdown 用编辑器当前内容（含未保存改动），其余按当前解读编码重读。 */
async function convertPayload(): Promise<{ text: string; encoding: string; eol: string; bom: boolean } | null> {
  const base = store.root;
  const target = rel.value;
  if (!base || !target) return null;
  if (kind.value === "markdown" && text.value) {
    return { text: mdDraft.value, encoding: text.value.encoding, eol: text.value.eol, bom: text.value.bom };
  }
  const loaded = await api.kbReadText(base, target, forcedEncoding?.rel === target ? forcedEncoding.encoding : undefined);
  return { text: loaded.text, encoding: loaded.encoding, eol: loaded.eol, bom: loaded.bom };
}

const convertData = ref<{ text: string; encoding: string; eol: string; bom: boolean } | null>(null);
watch(convertOpen, async (open) => {
  if (!open) {
    convertData.value = null;
    return;
  }
  convertData.value = await convertPayload();
});

/** 另存完成：打开新文件（让用户立刻看到结果），并刷新树（在对话框里已刷新该目录）。 */
function onConverted(nextRel: string): void {
  store.openFile(nextRel);
  pushToast({ kind: "success", message: t("kb.convertDone" as Parameters<typeof t>[0], { name: nextRel.split("/").pop() ?? nextRel }) }, 3000);
}

/** 状态栏点了页码 → 跳到那一页。 */
watch(
  () => store.pageJump,
  (page) => {
    if (page && previewInstance?.reveal) previewInstance.reveal(page);
    if (page) store.requestPageJump(0);
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
  if (kind.value !== "markdown") return;
  event.preventDefault();
  void saveDraft();
}

async function load(): Promise<void> {
  releaseImage();
  releaseSystemPoster();
  previewInstance?.destroy?.();
  previewInstance = null;
  unsupported.value = false;
  resolvedPluginId.value = null;
  conflict.value = false;
  textFallback.value = false;
  text.value = null;
  zoom.value = null;
  pluginTools.value = [];
  pluginZoomModes.value = ["page"];
  pluginOutline.value = [];
  store.setPaging(null);
  store.setSection(null);
  store.setPreviewInfo(null);
  basemapOn.value = false;
  store.setActiveFormat(null);
  findOpen.value = false;
  lastFindQuery.value = "";
  error.value = null;
  store.setActiveText(null);
  const base = store.root;
  const target = rel.value;
  if (!base || !target || !isTauri()) return;
  // 手动编码只对"它被指定的那个文件"生效；换了文件就丢掉
  if (forcedEncoding && forcedEncoding.rel !== target) forcedEncoding = null;
  const forced = forcedEncoding?.rel === target ? forcedEncoding.encoding : undefined;
  loading.value = true;
  try {
    if (kind.value === "image") {
      // SVG 也走字节流（不进 DOM，避免脚本上下文），但**必须带对 MIME**：
      // 无类型的 blob 在 WebKit 下 SVG 会当纯文本 → 打开是一片空白
      const bytes = await api.kbReadBytes(base, target);
      imageUrl.value = URL.createObjectURL(new Blob([bytes], { type: imageMimeFor(ext.value) }));
      // 图片也要报格式与体积（否则状态栏对 png/svg 仍显示兜底的「纯文本」）
      store.setActiveFormat({ label: t(formatLabelKey(ext.value, "image") as Parameters<typeof t>[0]), size: bytes.byteLength });
    } else if (kind.value === "other") {
      // 元信息（头部显示大小/时间）走 stat；渲染交给注册表
      const stat = await api.kbStat(base, target);
      text.value = { text: "", encoding: "", bom: false, eol: "\n", size: stat.size, mtimeMs: stat.mtimeMs };
      await renderViaRegistry(base, target, stat.size, forced);
    } else {
      const buffered = store.buffers[target];
      if (buffered) {
        // 该页签有未落盘的编辑（或刚打开过）：直接用缓冲，**不要**用磁盘内容覆盖
        text.value = { ...buffered.meta, text: buffered.text };
        mdDraft.value = buffered.text;
        mdDirty.value = buffered.dirty;
      } else {
        text.value = await api.kbReadText(base, target, forced);
        mdDraft.value = text.value.text;
        mdDirty.value = false;
      }
      store.setBuffer(target, { text: mdDraft.value, meta: text.value!, dirty: mdDirty.value });
      // 状态栏的 编码 / 换行 / 大小（编辑器到位后再补行列与制表位）
      store.setActiveText(text.value);
    }
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

defineExpose({ setViewMode });

watch(
  rel,
  (_next, previous) => {
    // 切走前落一次缓冲（编辑器即将重挂载，草稿只在组件里）
    const meta = text.value;
    if (previous && meta && store.buffers[previous]) {
      store.setBuffer(previous, { text: mdDraft.value, meta, dirty: mdDirty.value });
    }
  },
);

watch([rel, () => store.root, () => props.reloadTick], () => void load(), { immediate: true });
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  releaseImage();
  releaseSystemPoster();
  previewInstance?.destroy?.();
  previewInstance = null;
  window.removeEventListener("keydown", onKeydown);
});

/** 用外部程序打开：应用由 Rust 按「设置 → 打开方式」解析（未配置 = 系统默认）。 */
async function openDefault(): Promise<void> {
  const base = store.root;
  const target = rel.value;
  if (!base || !target) return;
  try {
    await openPathWithConfiguredApp(base, target);
  } catch (e) {
    error.value = String(e);
  }
}
async function reveal(): Promise<void> {
  if (!absPath.value) return;
  try {
    await revealPath(absPath.value);
  } catch (e) {
    error.value = String(e);
  }
}

/** 图片的视口 = 内容区（它才是滚动父级；注册表格式的那个 host 对图片并不存在）。 */
function imageViewport(): Size {
  const box = bodyEl.value;
  if (!box) return { width: 0, height: 0 };
  const rect = box.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function naturalSize(): Size {
  const el = imageEl.value;
  if (!el) return { width: 0, height: 0 };
  return { width: el.naturalWidth || el.width, height: el.naturalHeight || el.height };
}

/** 位图不放大（小图拉满屏只会糊）；SVG 是矢量的，放大反而更清晰。 */
const RASTER_EXT = new Set(["png", "jpg", "jpeg", "jfif", "gif", "webp", "bmp", "avif", "ico", "cur", "apng"]);

const imageZoom = new ZoomController({
  content: () => naturalSize(),
  viewport: () => imageViewport(),
  allowUpscale: !RASTER_EXT.has(ext.value),
  apply: (scale) => {
    const el = imageEl.value;
    if (!el) return;
    const natural = naturalSize();
    el.style.width = natural.width > 0 ? `${Math.round(natural.width * scale)}px` : "";
    el.style.maxWidth = "none";
    el.style.maxHeight = "none";
  },
  report: (state) => {
    zoom.value = state;
  },
});

/** 缩放入口：图片与插件共用（谁持有画面谁执行）。 */
function toggleBasemap(): void {
  const next = previewInstance?.toggleBasemap?.(!basemapOn.value);
  if (typeof next === "boolean") basemapOn.value = next;
}

function onZoomAction(action: ZoomAction): void {
  if (kind.value === "image") {
    if (action === "fit") imageZoom.fit();
    else if (action === "fit-width") imageZoom.fit("width");
    else if (action === "fit-page") imageZoom.fit("page");
    else imageZoom.step(action);
    return;
  }
  previewInstance?.zoom?.(action);
}

/** 图片刚加载完：默认「适应窗口」（= 100%），与其它视图类保持一致。 */
function onImageLoaded(): void {
  imageZoom.fit();
}
</script>

<template>
  <section class="preview" :data-plugin="resolvedPluginId ?? ''" :data-kind="kind">
    <header v-if="rel" class="preview-header">
      <div class="head-left">
        <EditorIcon :name="kind === 'markdown' ? 'o.markdown' : kind === 'image' ? 'o.file-media' : 'o.file'" />
        <span class="file-name">{{ name }}</span>
        <span v-if="text" class="meta">{{ humanSize(text.size) }}</span>
        <!-- 编码：**就在原来那个 chip 的位置**，但从"只读标识"变成可点控件
             （点开 = 改解读方式 / 转换另存为）。BOM 折进标签，不再单独占一格。 -->
        <button
          v-if="currentEncoding"
          class="meta chip enc-chip"
          :title="t('kb.encodingMenuTip')"
          @click="openEncodingMenu($event)"
        >
          {{ encodingLabel }}
        </button>
        <span v-if="text?.eol === '\r\n'" class="meta chip">CRLF</span>
        <span v-if="kind === 'markdown' && mdDirty" class="meta dirty" :title="t('kb.unsavedTip')">●</span>
      </div>
      <MarkdownToolbar
        v-if="kind === 'markdown'"
        class="head-toolbar"
        :groups="EDITOR_COMMAND_GROUPS"
        size="panel"
        @run="runEditorCommand"
      />
      <div class="head-actions">
        <!-- 只在**确实有结构**时给入口：没有书签/标题的文档点开只会是个空面板 -->
        <button
          v-if="kind === 'markdown' || pluginOutline.length > 0"
          class="icon-btn"
          :class="{ on: outlineOpen }"
          :title="t('kb.toggleOutline')"
          @click="toggleOutline"
        >
          <EditorIcon name="o.list-ordered" />
        </button>
        <button
          v-if="kind === 'markdown'"
          class="icon-btn"
          :class="{ on: !livePreview }"
          :title="t('kb.toggleSource')"
          @click="toggleSourceMode"
        >
          <EditorIcon name="o.md-code" />
        </button>
        <button
          v-if="kind === 'markdown' || pluginFind"
          class="icon-btn"
          :title="kind === 'markdown' ? t('kb.findTitle') : t('kb.findPlainTitle')"
          @click="openFind"
        >
          <EditorIcon name="o.search" />
        </button>
        <!-- 缩放：视图类预览（图片 / CAD / PDF / 3D…）由插件声明能力，面板统一出控件 -->
        <div v-if="zoomSupported" class="zoom-group">
          <button class="icon-btn" :title="t('kb.zoomOut')" @click="onZoomAction('out')">
            <EditorIcon name="o.zoom-out" />
          </button>
          <button class="zoom-level" :title="t('kb.zoomReset')" @click="onZoomAction('fit')">
            {{ zoom?.percent ?? 100 }}%
          </button>
          <button class="icon-btn" :title="t('kb.zoomIn')" @click="onZoomAction('in')">
            <EditorIcon name="o.zoom-in" />
          </button>
          <button
            v-if="zoomModes.length < 2"
            class="icon-btn"
            :class="{ on: zoom?.fit }"
            :title="t('kb.zoomFit')"
            @click="onZoomAction('fit')"
          >
            <EditorIcon name="o.screen-full" />
          </button>
          <!-- 文档类有两种「适应」口径（宽度 / 页面）：做成下拉，当前口径打勾 -->
          <DropdownMenu
            v-else
            class="zoom-fit-menu"
            :options="zoomFitItems"
            :model-value="zoom?.mode ?? ''"
            @update:model-value="pickFitMode(String($event))"
          >
            <template #trigger="{ open, toggle }">
              <button
                class="icon-btn"
                :class="{ on: open || zoom?.fit }"
                :title="t('kb.zoomFitMenuTip')"
                @click="toggle"
              >
                <EditorIcon name="o.screen-full" />
              </button>
            </template>
          </DropdownMenu>
        </div>
        <!-- 编码：显示当前编码，菜单里给两类操作（"改解读方式"与"转换另存为"）。
             头部放**命令**、状态栏留**状态**——两处入口各自符合使用习惯（VS Code 的状态栏
             编码格也是可点的）。命令型菜单按规范用 ActionMenu。 -->
        <!-- 在线底图开关：插件声明 tools: ["basemap"] 时出现（GIS 用）。
             放头部而不是插件自己画浮动控件/信息条 —— 那是"两行头部 + 浮动缩放"的来源。 -->
        <button
          v-if="pluginTools.includes('basemap')"
          class="text-btn"
          :class="{ on: basemapOn }"
          :title="t('kb.basemapTip')"
          @click="toggleBasemap"
        >
          {{ basemapOn ? t("kb.basemapOff") : t("kb.basemapOn") }}
        </button>
        <!-- 主操作保持可见（不折叠）：折叠后它在 ⋯ 里只剩一项，反而更差 -->
        <button class="text-btn" @click="openDefault">{{ t("kb.openWithDefault") }}</button>
      </div>
    </header>

    <!-- 面包屑：路径分段可点，点击在文件树中定位（VS Code 同款交互）。
         只有一个段（根下文件）时也显示——点击仍可定位，不省略。 -->
    <nav v-if="rel && breadcrumbSegments.length" class="crumbs" :aria-label="t('kb.crumbsLabel')">
      <template v-for="(segment, index) in breadcrumbSegments" :key="segment.path">
        <span v-if="index > 0" class="crumb-sep">›</span>
        <button
          class="crumb"
          :class="{ current: index === breadcrumbSegments.length - 1 }"
          :title="segment.path"
          @click="emit('reveal-in-tree', segment.path)"
        >
          {{ segment.name }}
        </button>
      </template>
    </nav>
    <div ref="bodyEl" class="preview-body" :class="{ 'editor-active': kind === 'markdown' && !!text }">
      <p v-if="!rel" class="hint">{{ t("kb.noSelection") }}</p>
      <!-- 注意：注册表格式（kind === 'other'）**不能**被加载提示挤出分支链 ——
           插件的渲染容器必须先存在，`renderViaRegistry` 才拿得到 ref；
           这里放行后由容器的 data-loading 属性显示加载态。 -->
      <p v-else-if="loading && kind !== 'other'" class="hint">{{ t("common.loading") }}</p>
      <p v-else-if="error" class="hint warn">{{ error }}</p>
      <img
        v-else-if="kind === 'image' && imageUrl"
        ref="imageEl"
        class="image"
        :src="imageUrl"
        :alt="name"
        @load="onImageLoaded"
      />
      <!-- 插件预览：容器**始终是同一个 div**，侧栏是它的兄弟节点。
           曾把"有侧栏"和"无侧栏"写成两个 v-if 分支、各绑一次 ref —— 切分支时 Vue 会
           卸载旧 div（插件渲染的页面都在里面）再挂个空的新 div，于是点大纲跳转毫无反应
           （holders 已是游离节点）。容器只挂一次，侧栏显隐不影响它。 -->
      <div v-else-if="kind === 'other' && !unsupported" class="preview-other">
        <div ref="previewHost" class="preview-host" :data-loading-text="loading ? t('common.loading') : null" />
        <KnowledgeOutline
          v-if="showPluginOutline"
          class="preview-outline"
          :items="outlineItems"
          :active-index="pluginOutlineActiveIndex"
          @jump="jumpToLine"
        />
      </div>
      <SplitPane
        v-else-if="kind === 'markdown' && text && outlineOpen"
        direction="horizontal"
        :initial-ratio="editorRatio"
        :min="0.35"
        @update:ratio="persistEditorRatio"
      >
        <template #first>
          <MarkdownEditor
            :key="rel ?? ''"
            ref="editorRef"
            :model-value="mdDraft"
            :root="store.root ?? undefined"
            :rel="rel ?? undefined"
            :live-preview="livePreview"
            class="md"
            @update:model-value="onEditorInput"
            @cursor="store.setCursor"
            @outline="editorOutline = $event"
            @stats="store.setStats"
            @find="onEditorFindKey"
            @contextmenu="openContextMenu"
          />
        </template>
        <template #second>
          <KnowledgeOutline :items="outlineItems" :active-index="activeHeadingIndex" @jump="jumpToLine" />
        </template>
      </SplitPane>
      <MarkdownEditor
        v-else-if="kind === 'markdown' && text"
        ref="editorRef"
        :key="rel ?? ''"
        :model-value="mdDraft"
        :root="store.root ?? undefined"
        :rel="rel ?? undefined"
        :live-preview="livePreview"
        class="md"
        @update:model-value="onEditorInput"
        @cursor="store.setCursor"
        @outline="editorOutline = $event"
        @stats="store.setStats"
        @find="onEditorFindKey"
        @contextmenu="openContextMenu"
      />
      <pre v-else-if="kind === 'text' && text" class="code">{{ text.text }}</pre>
      <div v-if="conflict" class="conflict-bar">
        <EditorIcon name="o.alert" />
        <span class="conflict-text">{{ t("kb.conflictText") }}</span>
        <button class="text-btn" @click="reloadFromDisk">{{ t("kb.conflictReload") }}</button>
        <button class="text-btn primary" @click="saveForced">{{ t("kb.conflictOverwrite") }}</button>
      </div>

      <div v-if="findOpen" class="find-layer">
        <KnowledgeFindBar
          ref="findBarRef"
          auto-focus
          @query="onFindQuery"
          :replaceable="kind === 'markdown'"
          @next="pluginFind ? stepPluginFind(true) : (editorRef?.findNext(), syncFindStatus())"
          @previous="pluginFind ? stepPluginFind(false) : (editorRef?.findPrevious(), syncFindStatus())"
          @replace-one="(editorRef?.replaceNext(), syncFindStatus())"
          @replace-all="(editorRef?.replaceAllMatches(), syncFindStatus())"
          @close="closeFind"
        />
      </div>
      <ActionMenu
        v-if="encodingMenu"
        :items="encodingMenuItems"
        :anchor="encodingMenu"
        size="ui"
        @pick="onEncodingMenuPick"
        @close="encodingMenu = null"
      />
      <ActionMenu
        v-if="contextMenu"
        :items="contextItems"
        :anchor="contextMenu"
        size="ui"
        @pick="onContextPick"
        @close="contextMenu = null"
      />
      <!-- 卡片条件必须是 `unsupported` 本身：挂在 kind === 'other' 上会让"插件渲染成功"的
           文件也顶着一张"暂不支持"的卡片（曾经就是这样），语义完全反了 -->
      <KnowledgeConvertDialog
        v-if="convertOpen && convertData"
        :rel="rel ?? ''"
        :text="convertData.text"
        :source-encoding="convertData.encoding"
        :eol="convertData.eol"
        :bom="convertData.bom"
        @close="convertOpen = false"
        @done="onConverted"
      />
      <div v-if="kind === 'other' && unsupported" class="unsupported">
        <img v-if="systemPosterUrl" class="unsupported-poster" :src="systemPosterUrl" :alt="name" />
        <EditorIcon name="o.file" />
        <p class="unsupported-title">{{ t("kb.previewUnsupported") }}</p>
        <p class="unsupported-note">{{ t("kb.previewUnsupportedNote") }}</p>
        <button class="text-btn primary" @click="openDefault">{{ t("kb.openWithDefault") }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.preview {
  position: relative; /* 查找条以其为定位基准（叠在编辑区右上） */
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--bg-panel);
}
/* 缩放控件：三个图标按钮 + 中间一个可点的百分比（点了回 100%） */
/* 头部编码 chip：与其它 meta chip 同款，但可点（点开 = 改解读 / 转换另存为） */
.enc-chip {
  border: none;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.enc-chip:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.zoom-group {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  padding: 0 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.zoom-level {
  min-width: 44px;
  height: 20px;
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-sm);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.zoom-level:hover {
  color: var(--text);
}
/* 面包屑：header 下的细条，路径分段可点 */
.crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  padding: 3px 16px 2px;
  border-bottom: 1px solid var(--border);
  overflow: hidden;
}
.crumb {
  flex: none;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-sm);
  cursor: pointer;
}
.crumb:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.crumb.current {
  color: var(--text);
}
.crumb-sep {
  flex: none;
  color: var(--text-dim);
  font-size: var(--font-sm);
}
.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 34px;
  padding: 0 8px 0 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.head-left {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.file-name {
  font-size: var(--font-base);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: var(--font-sm);
  color: var(--text-dim);
  flex: none;
}
.meta.chip {
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: var(--font-xs);
}
.conflict-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--warning-soft);
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-size: var(--font-md);
  flex: none;
}
.conflict-text {
  flex: 1;
  min-width: 0;
}
.find-layer {
  position: absolute;
  top: 10px;
  right: 18px;
  z-index: 30;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
/* 工具条占中部：可收缩、超出横向滚动（不再把文件动作挤到换行——
   历史上「刷新」按钮文字被挤成两行就是这个行宽压力造成的） */
.head-toolbar {
  flex: 1 1 auto;
  justify-content: center;
  margin: 0 8px;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.text-btn {
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  white-space: nowrap;
  flex: none;
  cursor: pointer;
}
.text-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.text-btn.primary {
  background: var(--btn-primary);
  border-color: var(--btn-primary-border);
  color: #fff;
  height: 26px;
}
.text-btn.primary:hover {
  background: var(--btn-primary-hover);
  color: #fff;
}
/**
 * 内容区**不垫边距**：垫了就是"外框 + 各渲染器自己的内边距"双重边距
 * （PDF 会在页面四周多出一圈灰边、docx 会左缩 28px）。各渲染器的内边距由它自己负责：
 * 文档类自带 10–16px（`.kb-code`/`.kb-docx`/`.kb-epub`…），铺满类（PDF/表格/地图/3D/CAD/视频）
 * 则**贴边**——这也是所有查看器的惯例（页面区域一直顶到面板边框）。
 */
.preview-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0;
}
/* Markdown 编辑器：铺满、无外边距，滚动由 CM6 自己管（避免双滚动条） */
.preview-body.editor-active {
  padding: 0;
  overflow: hidden;
}
.hint {
  /* 状态文案（空选择/加载中/错误）自带内边距：外层已不垫边距 */
  padding: 14px 16px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.hint.warn {
  color: var(--warning);
}
.image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  margin: 0 auto;
}
.code {
  /* 纯文本回退视图：同上，自带内边距 */
  margin: 0;
  padding: 14px 16px;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: var(--font-md);
  line-height: 1.6;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
/* 注册表渲染容器（PDF / 代码 / 压缩包 / 邮件…）：铺满可用空间、自己滚 */
.preview-other {
  display: flex;
  height: 100%;
  min-height: 0;
}
.preview-host {
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
  min-width: 0;
  overflow: auto;
}
/* 插件的大纲侧栏：与 Markdown 那套同一组件、同一视觉 */
.preview-outline {
  flex: none;
  width: 220px;
}
.preview-host :deep(.pdf-scroller) {
  overflow: auto;
  height: 100%;
  background: var(--bg-app);
}
/* 查找命中高亮：共享 DOM 查找（docx/xlsx/代码/邮件…）用 <mark>，PDF 用叠加框 */
.preview-host :deep(mark.kb-hit) {
  background: rgba(255, 196, 0, 0.38);
  color: inherit;
  border-radius: 2px;
}
.preview-host :deep(mark.kb-hit-current) {
  background: rgba(255, 145, 0, 0.62);
  box-shadow: 0 0 0 1px var(--accent);
}
/* 命中高亮：叠在页面之上（PDF 的文字画在 canvas 里，只能在上一层画框） */
.preview-host :deep(.pdf-hit) {
  position: absolute;
  pointer-events: none;
  background: rgba(255, 196, 0, 0.32);
  border-radius: 2px;
}
.preview-host :deep(.pdf-hit.current) {
  background: rgba(255, 145, 0, 0.55);
  box-shadow: 0 0 0 1px var(--accent);
}
.preview-host :deep(.pdf-page-holder) {
  position: relative;
}
.preview-host :deep(.pdf-pages) {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 页面之间与首末页留白由这里负责（外层不再垫边距） */
  gap: 12px;
  padding: 12px 0;
  padding: 16px;
}
.preview-host :deep(.pdf-page-holder) {
  width: 100%;
  max-width: 900px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-dim);
  font-size: var(--font-sm);
}
.preview-host :deep(.pdf-page-error) {
  color: var(--danger);
}
.preview-host :deep(.kb-code) {
  margin: 0;
  padding: 12px 16px;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: var(--font-md);
  line-height: 1.6;
  color: var(--text);
  tab-size: 4;
  white-space: pre;
}
.preview-host :deep(.kb-archive) {
  padding: 8px 12px;
}
.preview-host :deep(.kb-archive-row) {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 10px;
  align-items: center;
  height: 24px;
  font-size: var(--font-md);
  border-bottom: 1px solid var(--border);
}
.preview-host :deep(.kb-archive-row.dir .kb-archive-name) {
  font-weight: 600;
}
.preview-host :deep(.kb-archive-row.openable) {
  cursor: pointer;
}
.preview-host :deep(.kb-archive-row.openable:hover) {
  background: var(--bg-hover);
}
.preview-host :deep(.kb-archive-size),
.preview-host :deep(.kb-archive-time) {
  color: var(--text-dim);
  font-size: var(--font-sm);
}
.preview-host :deep(.kb-archive-preview) {
  margin: 6px 0 10px;
  padding: 8px 10px;
  background: var(--bg-app);
  border-radius: 6px;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: var(--font-md);
  max-height: 320px;
  overflow: auto;
}
.preview-host :deep(.kb-email) {
  padding: 12px 16px;
  max-width: 860px;
}
.preview-host :deep(.kb-email-head) {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  margin: 0 0 12px;
  font-size: var(--font-md);
}
.preview-host :deep(.kb-email-head dt) {
  color: var(--text-dim);
}
.preview-host :deep(.kb-email-head dd) {
  margin: 0;
}
.preview-host :deep(.kb-email-attachments) {
  margin-bottom: 10px;
  padding: 6px 8px;
  background: var(--bg-app);
  border-radius: 6px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.preview-host :deep(.kb-email-text) {
  margin: 0;
  white-space: pre-wrap;
  font-family: inherit;
  font-size: var(--font-base);
  line-height: 1.7;
}
.preview-host :deep(.kb-docx) {
  padding: 12px;
  background: var(--bg-app);
}
.preview-host :deep(.kb-docx .docx-wrapper) {
  background: transparent;
  padding: 0;
}
.preview-host :deep(.kb-docx .docx) {
  background: var(--bg-panel);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
.preview-host :deep(.kb-docx-fallback) {
  padding: 12px 16px;
  max-width: 860px;
}
.preview-host :deep(.kb-note) {
  margin: 8px 12px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.preview-host :deep(.kb-sheet) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.preview-host :deep(.kb-sheet-tabs) {
  display: flex;
  gap: 2px;
  padding: 6px 8px 0;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  flex: none;
}
.preview-host :deep(.kb-sheet-tab) {
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: 6px 6px 0 0;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  cursor: pointer;
  white-space: nowrap;
}
.preview-host :deep(.kb-sheet-tab.active) {
  background: var(--bg-chip);
  color: var(--text);
  font-weight: 600;
}
.preview-host :deep(.kb-sheet-body) {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px;
}
.preview-host :deep(.kb-sheet-table) {
  border-collapse: collapse;
  font-size: var(--font-md);
}
.preview-host :deep(.kb-sheet-table th),
.preview-host :deep(.kb-sheet-table td) {
  border: 1px solid var(--border);
  padding: 3px 8px;
  text-align: left;
  white-space: nowrap;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.preview-host :deep(.kb-sheet-table th) {
  background: var(--bg-app);
  font-weight: 600;
  position: sticky;
  top: 0;
}
.preview-host :deep(.kb-slides) {
  padding: 10px 14px;
}
.preview-host :deep(.kb-slide) {
  margin-bottom: 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.preview-host :deep(.kb-slide h3) {
  margin: 0 0 6px;
  font-size: var(--font-base);
  color: var(--text);
}
.preview-host :deep(.kb-slide ul) {
  margin: 0;
  padding-left: 20px;
  color: var(--text);
  font-size: var(--font-base);
  line-height: 1.7;
}
/* ---- 批次 3：OFD / EPUB / XPS / XMind / drawio ---- */
.preview-host :deep(.kb-ofd) {
  padding: 10px 0 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.preview-host :deep(.kb-ofd-page) {
  position: relative;
  flex: none;
  background: #fff;
  color: #000;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.preview-host :deep(.kb-ofd-text) {
  position: absolute;
  white-space: pre;
  line-height: 1;
  font-family: "SimSun", "Songti SC", serif;
}
.preview-host :deep(.kb-ofd-image) {
  position: absolute;
  object-fit: fill;
}
.preview-host :deep(.kb-epub) {
  max-width: 720px;
  margin: 0 auto;
  padding: 16px 20px 40px;
}
.preview-host :deep(.kb-epub-chapter) {
  color: var(--text);
  font-size: var(--font-base);
  line-height: 1.8;
}
.preview-host :deep(.kb-epub-chapter img) {
  max-width: 100%;
  height: auto;
}
.preview-host :deep(.kb-xps) {
  padding: 10px 14px 24px;
}
.preview-host :deep(.kb-xps-page) {
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}
.preview-host :deep(.kb-xps-page h3) {
  margin: 0 0 6px;
  font-size: var(--font-base);
  color: var(--text);
}
.preview-host :deep(.kb-xps-text) {
  margin: 0;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: var(--font-md);
  line-height: 1.7;
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
}
.preview-host :deep(.kb-xmind) {
  padding: 12px 18px 24px;
}
.preview-host :deep(.kb-xmind-sheet h3) {
  margin: 0 0 8px;
  font-size: var(--font-base);
  color: var(--text);
}
.preview-host :deep(.kb-xmind ul) {
  margin: 0;
  padding-left: 18px;
  list-style: none;
}
.preview-host :deep(.kb-xmind-topic) {
  position: relative;
  font-size: var(--font-base);
  color: var(--text);
  line-height: 1.9;
}
.preview-host :deep(.kb-xmind-topic.depth-0) {
  font-weight: 600;
}
.preview-host :deep(.kb-xmind-topic:not(.depth-0))::before {
  content: "";
  position: absolute;
  left: -10px;
  top: 0.95em;
  width: 6px;
  height: 1px;
  background: var(--border);
}
.preview-host :deep(.kb-drawio) {
  padding: 10px 14px 24px;
}
.preview-host :deep(.kb-drawio-canvas) {
  position: relative;
  min-width: 100%;
}
.preview-host :deep(.kb-drawio-box) {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-sm);
  text-align: center;
  overflow: hidden;
  box-sizing: border-box;
}
/* ---- 批次 4：媒体 / 3D / CAD / GIS ---- */
/* 注册表格式的加载态：容器内容归插件所有（会 replaceChildren），
   所以提示走伪元素 + attr()，不往里塞节点 */
.preview-host[data-loading-text]::after {
  content: attr(data-loading-text);
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.preview-host[data-loading-text] {
  position: relative;
}
.preview-host :deep(.kb-media) {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 10px;
  height: 100%;
  padding: 16px;
  min-height: 0;
}
.preview-host :deep(.kb-media-stage) {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
}
.preview-host :deep(.kb-media-audio .kb-media-stage) {
  flex: none;
}
.preview-host :deep(.kb-media audio) {
  width: min(560px, 100%);
}
.preview-host :deep(.kb-media video) {
  max-width: 100%;
  max-height: 100%;
  background: #000;
  border-radius: 6px;
}
.preview-host :deep(.kb-media-poster) {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
}
.preview-host :deep(.kb-media-meta) {
  flex: none;
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.preview-host :deep(.kb-lrc) {
  padding: 12px 18px 28px;
  max-width: 760px;
}
.preview-host :deep(.kb-lrc-meta) {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 10px;
  margin: 0 0 12px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.preview-host :deep(.kb-lrc-meta dt) {
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.preview-host :deep(.kb-lrc-meta dd) {
  margin: 0;
  color: var(--text);
}
.preview-host :deep(.kb-lrc-lines) {
  margin: 0;
  padding: 0;
  list-style: none;
}
.preview-host :deep(.kb-lrc-line) {
  display: flex;
  gap: 10px;
  padding: 3px 0;
  font-size: var(--font-base);
  color: var(--text);
  line-height: 1.7;
}
.preview-host :deep(.kb-lrc-time) {
  flex: none;
  width: 52px;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: var(--font-sm);
  color: var(--text-dim);
  padding-top: 2px;
}
.preview-host :deep(.kb-model3d) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.preview-host :deep(.kb-model3d-stage) {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
}
.preview-host :deep(.kb-model3d-stage canvas) {
  display: block;
  width: 100%;
  height: 100%;
}
.preview-host :deep(.kb-model3d-bar) {
  flex: none;
  margin: 0;
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.preview-host :deep(.kb-cad) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.preview-host :deep(.kb-cad-bar) {
  flex: none;
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.preview-host :deep(.kb-cad-canvas) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  color: var(--text);
}
.preview-host :deep(.kb-cad-canvas svg) {
  /* 宽度必须**显式给**：CAD 插件挂载时删掉了 SVG 自带的 width/height（那是图纸用户单位，
     26px 见方，太小），只留 viewBox。此时 WebKit 把「无内在尺寸的 SVG 在 flex 容器里」
     算成 0×0 —— 图纸打开一片空白，信息行却照常写着「… · 44 个图元」（用户实测）；
     同机 Chromium 会撑满容器，所以只在浏览器里验会漏掉。只写 max-width:100% 不够。
     WKWebView 实测：加 width:100% 前 svg rect = 0×0，加完 740×741.4、线宽 0.82px。 */
  width: 100%;
  height: auto;
  background: var(--bg-panel);
}
.preview-host :deep(.kb-gis) {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.preview-host :deep(.kb-gis-bar) {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.preview-host :deep(.kb-gis-tiles) {
  flex: none;
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: var(--font-sm);
  cursor: pointer;
}
.preview-host :deep(.kb-gis-tiles:hover) {
  background: var(--bg-hover);
}
.preview-host :deep(.kb-gis-map) {
  flex: 1 1 auto;
  min-height: 0;
  background: var(--bg-app);
  position: relative; /* 角标以此为定位基准 */
}
/* 地图右上合并信息条：要素数 + 比例尺 + 署名，同一个 div、无 border、视觉统一 */
.preview-host :deep(.kb-gis-info-corner) {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 450;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.9);
  color: var(--text);
  font-size: var(--font-xs);
  border-radius: 4px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  pointer-events: none;
}
/* 比例尺：只有文字（无 border / 无 Leaflet 的白底框），min-width 由 JS 动态设 */
.preview-host :deep(.kb-gis-scale) {
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  text-align: center;
  border: none !important;
  background: none !important;
}
/* leaflet 自带控件要跟我们的 token 走（它默认白底黑字，深色主题下刺眼） */
.preview-host :deep(.leaflet-container) {
  background: var(--bg-app);
  font-family: inherit;
  font-size: var(--font-sm);
}
.preview-host :deep(.leaflet-control-attribution),
.preview-host :deep(.leaflet-control-scale-line),
.preview-host :deep(.leaflet-bar a) {
  background: var(--bg-panel);
  color: var(--text-dim);
  border-color: var(--border);
}
.preview-host :deep(.leaflet-bar a:hover) {
  background: var(--bg-hover);
}
.unsupported {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-top: 48px;
  color: var(--text-dim);
}
.unsupported-poster {
  max-width: min(420px, 70%);
  max-height: 260px;
  object-fit: contain;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
}
.unsupported-title {
  margin: 0;
  font-size: var(--font-base);
  color: var(--text);
}
.unsupported-note {
  margin: 0 0 6px;
  font-size: var(--font-sm);
  text-align: center;
  max-width: 380px;
  line-height: 1.6;
}
</style>
