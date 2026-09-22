/**
 * 知识库状态：根目录（+ 最近列表）、懒加载的目录缓存、展开/选中、忽略文件开关。
 *
 * 与 `repo.ts` 的分工：仓库上下文（Issue/PR/看板）互不相干——知识库的根是用户
 * 自己选的任意文件夹，**不写 `.hivetask/`、不动 app.db**，一期只落 localStorage。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api, isTauri, type ExtApps, type KbEntry, type KbText, type OpenWithPrefs, type SystemApp } from "../api";
import { durableGet, durableSet } from "../ui-prefs";

const ROOT_KEY = "hivetask.kb.root";
const RECENT_KEY = "hivetask.kb.recent";
const IGNORED_KEY = "hivetask.kb.showIgnored";
const RECENT_MAX = 12;
/** 最近打开的**文件**（与「最近的知识库根」分开：一个记目录，一个记文件）。 */
const RECENT_FILES_KEY = "hivetask.kb.recentFiles";
const RECENT_FILES_MAX = 20;

function readRecentFiles(): string[] {
  try {
    const raw = durableGet("hivetask.kb.recentFiles");
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readLocal(key: string): string | null {
  // 走持久化桥：app.db 是真理、localStorage 是本安装形态的镜像（见 src/ui-prefs.ts）
  return durableGet(key);
}

function writeLocal(key: string, value: string | null): void {
  durableSet(key, value);
}

function loadRecent(): string[] {
  try {
    const parsed = JSON.parse(readLocal(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** 目录在前；同类按中文拼音/数字序（VS Code 也是按 locale 排的）。 */
function sortEntries(entries: KbEntry[]): KbEntry[] {
  return [...entries].sort((a, b) => {
    if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  });
}

export const useKnowledgeStore = defineStore("knowledge", () => {
  const root = ref<string | null>(readLocal(ROOT_KEY));
  const recent = ref<string[]>(loadRecent());
  const showIgnored = ref(readLocal(IGNORED_KEY) === "1");
  /** 根目录不存在（被移动/删除）——诚实空态，不清除记录，让用户重新选。 */
  const rootMissing = ref(false);
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** 已加载的目录：rel → 子项（懒加载，展开才拉）。 */
  const children = ref<Record<string, KbEntry[]>>({});
  const expanded = ref<Record<string, boolean>>({});
  /** 打开的文件页签（顺序即显示顺序）+ 当前页签；`selected` 与 activeTab 同步。 */
  const tabs = ref<string[]>([]);
  const selected = ref<string | null>(null);
  /** 「切换知识库」对话框开关——入口在 App header（与切换仓库/切换项目同位），
   *  对话框本身由 App.vue 用共享的 overlay 外壳渲染。 */
  const switchOpen = ref(false);
  /** 当前打开文件的文本元信息（编码/换行/大小）——状态栏用；二进制/图片为 null。 */
  const activeText = ref<KbText | null>(null);
  /**
   * 当前文件的**格式标签**（状态栏显示的那个）——由预览面板解析出渲染器后写入。
   * 文本/代码留空（状态栏按扩展名映射语言名）；PDF/docx/xlsx 这类必须由这里给，
   * 否则状态栏只会显示兜底的「纯文本」（用户实测发现的问题）。
   */
  const activeFormat = ref<{ label: string; size: number } | null>(null);
  /** 分页文档的当前页（PDF 等）——状态栏显示并可点击跳转。 */
  const paging = ref<{ page: number; total: number } | null>(null);
  /** 状态栏请求跳转的页码（面板消费后清零）。 */
  const pageJump = ref<number | null>(null);
  /** 字流文档的当前章节标题（docx 这类没有可信页码的格式用它当"当前位置"）。 */
  const section = ref<string | null>(null);
  /** 插件回报的格式信息（如「2 个要素」）——状态栏一格，避免插件自己画第二行头部。 */
  const previewInfo = ref<string | null>(null);
  /**
   * 全部文件清单缓存（⌘P 与搜索用）。一次 `kb_walk` 拿全量；任何写操作后失效。
   * 懒加载：不打开 ⌘P 就不付这次遍历。
   */
  const fileIndex = ref<string[] | null>(null);
  /** 最近打开的若干文件（⌘P 空查询时置顶；localStorage 持久化）。 */
  const recentFiles = ref<string[]>(readRecentFiles());
  /** 预览面板要跳到的行（搜索命中点击后消费，用完清零）。 */
  const jumpToLine = ref<{ rel: string; line: number } | null>(null);
  /**
   * 待知识库面板执行的命令（菜单/全局快捷键下发的通道）。
   * 面板消费后清零 —— 与 `pageJump` 同一套模式。
   */
  const pendingCommand = ref<"quickOpen" | "search" | null>(null);
  /** 状态栏请求"按此编码重新加载当前文件"（预览面板消费后清零）。 */
  const encodingRequest = ref<string | null>(null);
  /** 编辑器光标位置（行/列）——状态栏用；非 Markdown 或未聚焦时为 null。 */
  const cursor = ref<{ line: number; col: number } | null>(null);
  /** 编辑器缩进宽度（空格数）——状态栏按 VS Code 口径显示。 */
  const indentWidth = ref(2);
  /**
   * 每个已打开文件的编辑缓冲（rel → 文本 + 落盘元信息 + 脏标记）。
   *
   * 为什么必须有：切换页签时编辑器会重挂载，若只保留"当前一份草稿"，
   * **未保存的编辑会被静默丢弃**（真实数据丢失）。VS Code 的做法是每个页签各持一份缓冲，
   * 这里按同样口径做；`Close Saved` 这类命令也依赖它。
   */
  const buffers = ref<Record<string, { text: string; meta: KbText; dirty: boolean }>>({});
  /** 固定（Pin）的页签：批量关闭跳过它们，且排在页签条最前。 */
  const pinned = ref<string[]>([]);
  /**
   * 剪贴板（树右键菜单的剪切/复制 → 粘贴）。支持**多项**：多选后复制/剪切整批。
   */
  const clipboard = ref<{ op: "cut" | "copy"; rels: string[] } | null>(null);
  /**
   * 多选：选中的 rel 集合。与 `selected`（当前打开的那一个）分开 ——
   * VS Code 也是这么分的：选中集可以有很多项，只有"焦点项"会被打开。
   */
  const selection = ref<string[]>([]);
  /** Shift 范围选择的锚点（上一次"单选"落点）。 */
  const selectionAnchor = ref<string | null>(null);
  /**
   * 键盘导航的**焦点行**。与 `selected`（当前打开）和 `selection`（选中集）都不同：
   * 用 ↑↓ 移动的是它，回车才打开 —— VS Code 的树也是这三层。
   */
  const focusRel = ref<string | null>(null);
  /** 当前文档的字数/词数（编辑器上报；非 Markdown 为 null）。 */
  const stats = ref<{ chars: number; words: number } | null>(null);
  /** 树过滤词（空 = 不过滤）。匹配「名称或相对路径」，只作用于**已加载**的条目：
   *  未展开目录按其自身名称参与匹配，展开后才看得到内部命中。 */
  const filter = ref("");
  /** 「打开方式」偏好（defaultApp + byExt）。存 app.db：打开动作由 Rust 执行，
   *  配置也由 Rust 持有——前端只读写，不能在打开时指定程序。 */
  const openWith = ref<OpenWithPrefs>({ byExt: {} });
  const openWithLoaded = ref(false);
  /**
   * 系统应用清单。设置页每次挂载都重扫一遍 —— 扫描在 Rust 侧是几十毫秒的目录遍历，
   * 换来的好处是**刚装的应用重开设置就出现**（省掉"重启应用才刷新"那种困惑）。
   * 同一时刻只跑一次（in-flight 去重），失败当空表，不挡设置页。
   */
  const systemApps = ref<SystemApp[]>([]);
  let systemAppsInFlight: Promise<SystemApp[]> | null = null;

  const rootName = computed(() => {
    const path = root.value;
    if (!path) return "";
    const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
    return parts[parts.length - 1] || path;
  });

  function rememberRoot(path: string): void {
    root.value = path;
    writeLocal(ROOT_KEY, path);
    const next = [path, ...recent.value.filter((p) => p !== path)].slice(0, RECENT_MAX);
    recent.value = next;
    writeLocal(RECENT_KEY, JSON.stringify(next));
  }

  function forget(path: string): void {
    const next = recent.value.filter((p) => p !== path);
    recent.value = next;
    writeLocal(RECENT_KEY, JSON.stringify(next));
    if (root.value === path) {
      root.value = null;
      writeLocal(ROOT_KEY, null);
      reset();
    }
  }

  function reset(): void {
    children.value = {};
    buffers.value = {};
    pinned.value = [];
    expanded.value = {};
    tabs.value = [];
    selected.value = null;
    activeText.value = null;
    cursor.value = null;
    stats.value = null;
    filter.value = "";
    rootMissing.value = false;
    error.value = null;
  }

  async function loadDir(rel: string): Promise<void> {
    const base = root.value;
    if (!base || !isTauri()) return;
    loading.value = true;
    try {
      const entries = await api.kbListDir(base, rel, showIgnored.value);
      children.value = { ...children.value, [rel]: sortEntries(entries) };
      error.value = null;
    } catch (e) {
      error.value = String(e);
    } finally {
      loading.value = false;
    }
  }

  /** 递归刷新已展开的分支（保持展开状态）。 */
  async function refresh(rel = ""): Promise<void> {
    // 写操作后的统一刷新入口：顺带让 ⌘P/搜索的文件清单失效
    // （否则会给出已经删掉或改过名的路径）
    invalidateFileIndex();
    await loadDir(rel);
    for (const key of Object.keys(expanded.value)) {
      if (expanded.value[key] && key !== rel && key.startsWith(rel)) await loadDir(key);
    }
  }

  async function setRoot(path: string): Promise<void> {
    reset();
    rememberRoot(path);
    await loadDir("");
  }

  /** 启动探针：持久化的根可能已被移动/删除。 */
  async function probeRoot(): Promise<void> {
    // Dev affordance（同 VITE_AUTO_REPO 的做法）：VITE_AUTO_KB=/path 在开发环境
    // 预置知识库根，便于截图与演示；仅读 Vite 注入的变量，不参与打包发布。
    // 显式给定时**覆盖**已存的根：开发期换样本目录不该还要手点一遍「切换知识库」
    const autoRoot = import.meta.env.VITE_AUTO_KB as string | undefined;
    if (autoRoot && isTauri() && root.value !== autoRoot) {
      rememberRoot(autoRoot);
    }
    const base = root.value;
    if (!base || !isTauri()) return;
    try {
      const stat = await api.kbStat(base, "");
      rootMissing.value = !stat.exists || stat.kind !== "dir";
    } catch {
      rootMissing.value = true;
    }
    if (!rootMissing.value) await loadDir("");
  }

  async function toggleDir(rel: string): Promise<void> {
    const open = !expanded.value[rel];
    expanded.value = { ...expanded.value, [rel]: open };
    if (open && !children.value[rel]) await loadDir(rel);
  }

  function collapseAll(): void {
    expanded.value = {};
  }

  function select(rel: string): void {
    if (!tabs.value.includes(rel)) tabs.value = [...tabs.value, rel];
    selected.value = rel;
  }

  function setBuffer(rel: string, buffer: { text: string; meta: KbText; dirty: boolean }): void {
    buffers.value = { ...buffers.value, [rel]: buffer };
  }

  function dropBuffer(rel: string): void {
    const next = { ...buffers.value };
    delete next[rel];
    buffers.value = next;
  }

  function isDirty(rel: string): boolean {
    return buffers.value[rel]?.dirty === true;
  }

  /** 页签排序：固定页签在前（各保持原有相对顺序）。 */
  function reorderTabs(): void {
    const pinnedTabs = pinned.value.filter((rel) => tabs.value.includes(rel));
    const rest = tabs.value.filter((rel) => !pinnedTabs.includes(rel));
    tabs.value = [...pinnedTabs, ...rest];
  }

  /**
   * 固定/取消固定（VS Code 语义）：
   * - 固定 → 移到**固定组末尾**；
   * - 取消 → 回到**固定组之后的第一位**（不是留在最前，否则解除固定看不出变化）。
   */
  function togglePin(rel: string): void {
    if (pinned.value.includes(rel)) {
      pinned.value = pinned.value.filter((item) => item !== rel);
      const rest = tabs.value.filter((tab) => tab !== rel);
      rest.splice(pinned.value.length, 0, rel);
      tabs.value = rest;
      return;
    }
    pinned.value = [...pinned.value, rel];
    reorderTabs();
  }

  /** 关闭页签：激活中的页签关闭后，落到右邻（没有则左邻）。 */
  function closeTab(rel: string): void {
    const index = tabs.value.indexOf(rel);
    if (index < 0) return;
    const next = tabs.value.filter((t) => t !== rel);
    tabs.value = next;
    pinned.value = pinned.value.filter((item) => item !== rel);
    dropBuffer(rel);
    if (selected.value === rel) {
      selected.value = next[index] ?? next[index - 1] ?? null;
    }
  }

  function closeTabs(rels: string[]): void {
    for (const rel of rels) closeTab(rel);
  }

  /** Close Others：除自己与**固定页签**外全关（VS Code 语义：固定页签不动）。 */
  function closeOthers(rel: string): void {
    closeTabs(tabs.value.filter((tab) => tab !== rel && !pinned.value.includes(tab)));
  }

  /** Close to the Right：关掉它右侧的页签（固定页签跳过）。 */
  function closeToRight(rel: string): void {
    const index = tabs.value.indexOf(rel);
    if (index < 0) return;
    closeTabs(tabs.value.slice(index + 1).filter((tab) => !pinned.value.includes(tab)));
  }

  function closeAll(): void {
    closeTabs(tabs.value.filter((tab) => !pinned.value.includes(tab)));
  }

  /** Close Saved：只关**没有未保存修改**的页签（固定页签跳过）。 */
  function closeSaved(): number {
    const clean = tabs.value.filter((tab) => !isDirty(tab) && !pinned.value.includes(tab));
    closeTabs(clean);
    return clean.length;
  }

  /** 还有未保存修改的页签（关闭前确认用）。 */
  function dirtyTabs(rels?: string[]): string[] {
    const scope = rels ?? tabs.value;
    return scope.filter((rel) => isDirty(rel));
  }

  function openSwitch(): void {
    switchOpen.value = true;
  }

  function closeSwitch(): void {
    switchOpen.value = false;
  }

  /** 查找已加载条目（树是懒加载的，只在已拉取的层级里找）。 */
  function findEntry(rel: string): KbEntry | null {
    for (const list of Object.values(children.value)) {
      const hit = list.find((e) => e.rel === rel);
      if (hit) return hit;
    }
    return null;
  }

  /** 新建的落点：选中目录 → 它内部；选中文件 → 其父目录；未选中 → 根。 */
  const createParent = computed(() => {
    const sel = selected.value;
    if (!sel) return "";
    if (findEntry(sel)?.kind === "dir") return sel;
    return sel.includes("/") ? sel.slice(0, sel.lastIndexOf("/")) : "";
  });

  /**
   * 新建空文件 / 目录 → 刷新父目录（并展开）→ 选中新条目。
   *
   * `parentRel` 显式给定时用它（树右键菜单："在**这个**目录里新建"），
   * 否则回落到"按当前选中推断"（面板头 ＋ 按钮的语义）。
   */
  async function createEntry(kind: "file" | "dir", name: string, parentRel?: string): Promise<KbEntry> {
    const base = root.value;
    if (!base) throw new Error("尚未选择知识库文件夹");
    const parent = parentRel ?? createParent.value;
    const rel = parent ? `${parent}/${name}` : name;
    const entry = await api.kbCreate(base, rel, kind);
    if (parent) expanded.value = { ...expanded.value, [parent]: true };
    await loadDir(parent);
    children.value = { ...children.value };
    if (kind === "dir") expanded.value = { ...expanded.value, [entry.rel]: true };
    select(entry.rel);
    return entry;
  }

  function setActiveFormat(value: { label: string; size: number } | null): void {
    activeFormat.value = value;
  }

  function setPaging(value: { page: number; total: number } | null): void {
    paging.value = value;
  }

  function setSection(value: string | null): void {
    section.value = value;
  }

  function setPreviewInfo(value: string | null): void {
    previewInfo.value = value;
  }

  function requestPageJump(page: number): void {
    pageJump.value = page;
  }

  /** 打开一个文件：切页签 + 记入「最近打开」（⌘P 的置顶依据）。 */
  function openFile(rel: string): void {
    select(rel);
    recentFiles.value = [rel, ...recentFiles.value.filter((item) => item !== rel)].slice(0, RECENT_FILES_MAX);
    try {
      durableSet(RECENT_FILES_KEY, JSON.stringify(recentFiles.value));
    } catch {
      // 存储不可用 → 本次会话内仍然生效
    }
  }

  /** 全量文件清单（懒加载 + 缓存；写操作后调 `invalidateFileIndex`）。 */
  async function loadFileIndex(force = false): Promise<string[]> {
    const base = root.value;
    if (!base) return [];
    if (!force && fileIndex.value) return fileIndex.value;
    const files = await api.kbWalk(base, showIgnored.value);
    fileIndex.value = files;
    return files;
  }

  function invalidateFileIndex(): void {
    fileIndex.value = null;
  }

  /** 请求预览跳到某文件的某一行（搜索命中点击用）。 */
  function requestJump(rel: string, line: number): void {
    jumpToLine.value = { rel, line };
  }

  function clearJump(): void {
    jumpToLine.value = null;
  }

  function runCommand(command: "quickOpen" | "search"): void {
    pendingCommand.value = command;
  }

  function clearCommand(): void {
    pendingCommand.value = null;
  }

  function requestEncoding(encoding: string): void {
    encodingRequest.value = encoding;
  }

  function clearEncodingRequest(): void {
    encodingRequest.value = null;
  }

  function setActiveText(value: KbText | null): void {
    activeText.value = value;
  }

  function setCursor(value: { line: number; col: number } | null): void {
    cursor.value = value;
  }

  function setStats(value: { chars: number; words: number } | null): void {
    stats.value = value;
  }

  // ---- 管理操作（树右键菜单）----

  /** 重命名：改完刷新父目录并保持选中（打开的页签与选中路径一起迁移）。 */
  async function renameEntry(from: string, nextName: string): Promise<void> {
    const base = root.value;
    if (!base) throw new Error("尚未选择知识库文件夹");
    const parent = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    const to = parent ? `${parent}/${nextName}` : nextName;
    await api.kbRename(base, from, to);
    // 页签跟随（否则页签指向一个已不存在的路径）
    tabs.value = tabs.value.map((tab) => (tab === from ? to : tab));
    if (selected.value === from) selected.value = to;
    await loadDir(parent);
    children.value = { ...children.value };
  }

  function setClipboard(value: { op: "cut" | "copy"; rels: string[] } | null): void {
    clipboard.value = value;
  }

  /** 打开/选中的路径从 `from` 迁到 `to`（含其子树里的页签）。 */
  function migratePaths(from: string, to: string): void {
    tabs.value = tabs.value.map((tab) =>
      tab === from ? to : tab.startsWith(`${from}/`) ? tab.replace(from, to) : tab,
    );
    if (selected.value === from || selected.value?.startsWith(`${from}/`)) {
      selected.value = selected.value === from ? to : selected.value.replace(from, to);
    }
  }

  /**
   * 粘贴到目标目录：剪切 → 移动；复制 → 复制（重名自动加 `-copy`/序号）。
   * 支持**多项**（多选后复制/剪切整批）；重名的处理逐项独立。
   */
  async function pasteInto(parentRel: string): Promise<string> {
    const base = root.value;
    const clip = clipboard.value;
    if (!base || !clip || clip.rels.length === 0) throw new Error("剪贴板是空的");
    if (parentRel) expanded.value = { ...expanded.value, [parentRel]: true };
    let lastTarget = "";
    for (const rel of clip.rels) {
      const name = rel.split("/").pop() ?? rel;
      const target = await uniqueTarget(parentRel, name);
      const entry =
        clip.op === "cut"
          ? await api.kbMove(base, rel, target)
          : await api.kbCopy(base, rel, target);
      lastTarget = entry.rel ?? target;
      if (clip.op === "cut") migratePaths(rel, target);
    }
    if (clip.op === "cut") clipboard.value = null; // 剪切是一次性的
    const entry = { rel: lastTarget };
    await loadDir(parentRel);
    children.value = { ...children.value };
    return entry.rel;
  }

  /** 目标目录内的可用名：`name` 已存在则依次尝试 `name-copy`、`name-copy-2`… */
  async function uniqueTarget(parentRel: string, name: string): Promise<string> {
    const base = root.value;
    if (!base) throw new Error("尚未选择知识库文件夹");
    const existing = new Set((children.value[parentRel] ?? []).map((entry) => entry.name));
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let index = 0; index < 50; index += 1) {
      const candidate = index === 0 ? `${stem}-copy${ext}` : `${stem}-copy-${index + 1}${ext}`;
      if (!existing.has(candidate)) return parentRel ? `${parentRel}/${candidate}` : candidate;
    }
    throw new Error("同名副本过多");
  }

  /** 删除：进回收站；相关页签一并关闭。 */
  async function deleteEntry(rel: string): Promise<void> {
    const base = root.value;
    if (!base) throw new Error("尚未选择知识库文件夹");
    await api.kbDelete(base, rel);
    const prefix = `${rel}/`;
    tabs.value = tabs.value.filter((tab) => tab !== rel && !tab.startsWith(prefix));
    if (selected.value === rel || selected.value?.startsWith(prefix)) {
      selected.value = tabs.value[0] ?? null;
    }
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    await loadDir(parent);
    children.value = { ...children.value };
  }

  // ---- 打开方式 ----

  async function loadOpenWith(): Promise<void> {
    if (!isTauri()) return;
    try {
      openWith.value = await api.kbOpenPrefsGet();
    } catch {
      // 读失败保持默认（系统默认程序），不阻塞设置面板
    } finally {
      openWithLoaded.value = true;
    }
  }

  async function saveOpenWith(next: OpenWithPrefs): Promise<void> {
    openWith.value = next;
    if (!isTauri()) return;
    await api.kbOpenPrefsSet(next);
  }

  /** 已安装应用（每次调用都会重扫；并发调用合并成一次）。 */
  async function loadSystemApps(): Promise<SystemApp[]> {
    if (!isTauri()) return [];
    systemAppsInFlight ??= api.kbAppsList().catch(() => []);
    try {
      systemApps.value = await systemAppsInFlight;
    } finally {
      systemAppsInFlight = null;
    }
    return systemApps.value;
  }

  /** 某个扩展名在系统里的默认应用与候选（扩展名为空 / 非 Tauri 时返回空表）。 */
  async function appsForExt(ext: string): Promise<ExtApps> {
    const cleaned = ext.trim().replace(/^\./, "").toLowerCase();
    if (!isTauri() || !cleaned) return { default: null, candidates: [] };
    try {
      return await api.kbAppsForExt(cleaned);
    } catch {
      return { default: null, candidates: [] };
    }
  }

  // ---- 树过滤 ----

  function setFilter(value: string): void {
    filter.value = value.trim().toLowerCase();
  }

  /** 条目是否命中（自身路径命中，或任一已加载后代命中）。 */
  function matches(entry: KbEntry, query: string): boolean {
    if (entry.rel.toLowerCase().includes(query)) return true;
    const kids = children.value[entry.rel];
    return !!kids && kids.some((kid) => matches(kid, query));
  }

  /** 某目录在**当前过滤态下**应显示的子项。 */
  function visibleChildren(rel: string): KbEntry[] {
    const list = children.value[rel] ?? [];
    const query = filter.value;
    return query ? list.filter((entry) => matches(entry, query)) : list;
  }

  /**
   * **可见行**的扁平顺序（按当前展开态 + 过滤态）——Shift 范围选择与"全选"按它走。
   * 折叠的目录不展开其子项（与用户看到的一致）。
   */
  function visibleRows(): { rel: string; kind: KbEntry["kind"] }[] {
    const rows: { rel: string; kind: KbEntry["kind"] }[] = [];
    const walk = (dirRel: string): void => {
      for (const entry of visibleChildren(dirRel)) {
        rows.push({ rel: entry.rel, kind: entry.kind });
        if (entry.kind === "dir" && (expanded.value[entry.rel] || hasMatchInside(entry.rel))) {
          walk(entry.rel);
        }
      }
    };
    walk("");
    return rows;
  }

  /** 焦点行的下标（不在可见行里时返回 -1）。 */
  function focusIndex(): number {
    const rows = visibleRows();
    return focusRel.value ? rows.findIndex((row) => row.rel === focusRel.value) : -1;
  }

  /**
   * 移动焦点（VS Code 语义）：↑↓ 单步、Home/End 到首末。
   * `extend` = 按住 Shift：只扩选、不改变锚点；否则单选并重置锚点。
   */
  function moveFocus(to: "up" | "down" | "first" | "last", extend = false): void {
    const rows = visibleRows();
    if (!rows.length) return;
    const current = focusIndex();
    let next: number;
    switch (to) {
      case "first":
        next = 0;
        break;
      case "last":
        next = rows.length - 1;
        break;
      case "down":
        next = current < 0 ? 0 : Math.min(current + 1, rows.length - 1);
        break;
      default:
        next = current <= 0 ? 0 : current - 1;
    }
    const rel = rows[next].rel;
    focusRel.value = rel;
    if (extend) {
      if (selectionAnchor.value === null) selectionAnchor.value = rows[current < 0 ? next : current].rel;
      selectRange(rel);
      return;
    }
    selectOnly(rel);
  }

  /** →：目录展开；已展开则进到第一个子项。文件上无动作（回车才是打开）。 */
  async function focusExpand(): Promise<void> {
    const rel = focusRel.value;
    if (!rel) return;
    const row = visibleRows().find((item) => item.rel === rel);
    if (!row || row.kind !== "dir") return;
    if (!expanded.value[rel] && !hasMatchInside(rel)) {
      await toggleDir(rel);
      return;
    }
    const rows = visibleRows();
    const index = rows.findIndex((item) => item.rel === rel);
    const child = rows[index + 1];
    if (child && child.rel.startsWith(`${rel}/`)) {
      focusRel.value = child.rel;
      selectOnly(child.rel);
    }
  }

  /** ←：目录收起；否则跳到父目录（VS Code 同款）。 */
  async function focusCollapse(): Promise<void> {
    const rel = focusRel.value;
    if (!rel) return;
    const row = visibleRows().find((item) => item.rel === rel);
    if (row?.kind === "dir" && expanded.value[rel]) {
      await toggleDir(rel);
      return;
    }
    const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    if (!rel.includes("/")) return; // 顶层项没有父级
    focusRel.value = parent;
    selectOnly(parent);
  }

  /** 只选这一项（普通点击）。 */
  function selectOnly(rel: string): void {
    selection.value = [rel];
    selectionAnchor.value = rel;
    focusRel.value = rel;
  }

  /** ⌘/Ctrl 点击：加选 / 取消选择（VS Code 同款）。 */
  function toggleSelection(rel: string): void {
    selection.value = selection.value.includes(rel)
      ? selection.value.filter((item) => item !== rel)
      : [...selection.value, rel];
    selectionAnchor.value = rel;
  }

  /** Shift 点击：从锚点到这一项的范围（按可见顺序）。 */
  function selectRange(rel: string): void {
    const rows = visibleRows().map((row) => row.rel);
    const anchor = selectionAnchor.value ?? rel;
    const from = rows.indexOf(anchor);
    const to = rows.indexOf(rel);
    if (from < 0 || to < 0) {
      selectOnly(rel);
      return;
    }
    const [start, end] = from <= to ? [from, to] : [to, from];
    selection.value = rows.slice(start, end + 1);
  }

  function selectAllVisible(): void {
    selection.value = visibleRows().map((row) => row.rel);
  }

  function clearSelection(): void {
    selection.value = [];
    selectionAnchor.value = null;
  }

  /** 批量操作后直接设定选中集（移动后选中新位置 = VS Code 的做法）。 */
  function setSelection(rels: string[]): void {
    selection.value = [...rels];
    selectionAnchor.value = rels[0] ?? null;
  }

  /** 删除后把失效路径从选中集里摘掉。 */
  function removeFromSelection(rels: string[]): void {
    const gone = new Set(rels);
    selection.value = selection.value.filter((rel) => !gone.has(rel));
    if (selectionAnchor.value && gone.has(selectionAnchor.value)) selectionAnchor.value = null;
  }

  function isSelected(rel: string): boolean {
    return selection.value.includes(rel);
  }

  /** 选中项里"实际存在"的那些（删除/移动后要修剪掉失效路径）。 */
  function pruneSelection(existing: Set<string>): void {
    selection.value = selection.value.filter((rel) => existing.has(rel));
    if (selectionAnchor.value && !existing.has(selectionAnchor.value)) selectionAnchor.value = null;
    if (clipboard.value) {
      const rels = clipboard.value.rels.filter((rel) => existing.has(rel));
      clipboard.value = rels.length ? { ...clipboard.value, rels } : null;
    }
  }

  /** 过滤态下目录是否含命中后代（含则强制展开）。 */
  function hasMatchInside(rel: string): boolean {
    const query = filter.value;
    if (!query) return false;
    return (children.value[rel] ?? []).some((entry) => matches(entry, query));
  }

  /** 过滤结果为空（用于空态提示）。 */
  const filterEmpty = computed(
    () => !!filter.value && visibleChildren("").length === 0,
  );

  async function setShowIgnored(value: boolean): Promise<void> {
    showIgnored.value = value;
    writeLocal(IGNORED_KEY, value ? "1" : null);
    // 重新拉所有已加载目录，避免「切换后树里还是旧的过滤结果」
    const keys = Object.keys(children.value);
    children.value = {};
    for (const rel of keys) await loadDir(rel);
  }

  /** 切换根（原生文件夹选择）。取消返回 null。 */
  async function pickRoot(): Promise<string | null> {
    if (!isTauri()) return null;
    const picked = await api.kbPickRoot();
    if (picked) await setRoot(picked);
    return picked;
  }

  return {
    root,
    rootName,
    recent,
    showIgnored,
    rootMissing,
    loading,
    error,
    children,
    expanded,
    tabs,
    selected,
    switchOpen,
    activeText,
    activeFormat,
    setActiveFormat,
    paging,
    setPaging,
    section,
    setSection,
    previewInfo,
    setPreviewInfo,
    pageJump,
    requestPageJump,
    createParent,
    openWith,
    openWithLoaded,
    systemApps,
    cursor,
    indentWidth,
    stats,
    filter,
    filterEmpty,
    visibleChildren,
    hasMatchInside,
    setFilter,
    setRoot,
    probeRoot,
    loadDir,
    refresh,
    toggleDir,
    collapseAll,
    select,
    closeTab,
    createEntry,
    renameEntry,
    deleteEntry,
    setActiveText,
    setCursor,
  setStats,
    clipboard,
    fileIndex,
    recentFiles,
    openFile,
    loadFileIndex,
    invalidateFileIndex,
    jumpToLine,
    requestJump,
    clearJump,
    pendingCommand,
    runCommand,
    clearCommand,
    encodingRequest,
    requestEncoding,
    clearEncodingRequest,
    selection,
    focusRel,
    moveFocus,
    focusExpand,
    focusCollapse,
    selectOnly,
    toggleSelection,
    selectRange,
    selectAllVisible,
    clearSelection,
    setSelection,
    removeFromSelection,
    isSelected,
    visibleRows,
    pruneSelection,
    buffers,
    pinned,
    setBuffer,
    dropBuffer,
    isDirty,
    dirtyTabs,
    togglePin,
    closeOthers,
    closeToRight,
    closeAll,
    closeSaved,
    setClipboard,
    pasteInto,
    loadOpenWith,
    saveOpenWith,
    loadSystemApps,
    appsForExt,
    openSwitch,
    closeSwitch,
    setShowIgnored,
    pickRoot,
    forget,
  };
});
