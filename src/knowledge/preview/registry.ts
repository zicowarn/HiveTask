/**
 * 预览插件注册表 —— 全部格式的唯一入口。
 *
 * 设计（参照 open-file-viewer 的插件契约，逐文件对照后重写，MIT，见 THIRD-PARTY.md）：
 * - **判定双路**：扩展名优先，`magic`（文件头字节）兜底 —— 无扩展名/改名的文件也能认出来；
 * - **按需加载**：每个格式的渲染器都走动态 `import()`，只有真打开才付那份体积
 *   （pdfjs / docx-preview / three 这些动辄几百 KB）；
 * - **统一上下文**：插件只拿到 `{ root, rel, name, ext, readBytes, readText, container }`，
 *   不直接碰 Tauri 命令 —— 便于测试与统一沙箱。
 *
 * 新增格式只需在这里注册一条 + 写一个 `render` 模块，不改预览面板。
 */
import type { KbEntry } from "../../api";

export interface PreviewFileInfo {
  /** 知识库根。 */
  root: string;
  /** 相对根的路径。 */
  rel: string;
  /** 文件名（含扩展名）。 */
  name: string;
  /** 小写扩展名（不含点）；无扩展名时为空串。 */
  ext: string;
}

export interface PreviewContext extends PreviewFileInfo {
  /** 渲染容器（插件自行填充；销毁时由宿主清空）。 */
  container: HTMLElement;
  /** 读原始字节（走 kb_read_bytes：根沙箱 + 32MB 上限）。 */
  readBytes: () => Promise<Uint8Array>;
  /** 读文本（走 kb_read_text：编码探测 + 换行归一）。 */
  readText: () => Promise<string>;
  /**
   * 读**同知识库内另一个文件**的字节（相对根的路径）。
   * 给 HLS 分片、3D 的 .bin 附件、shp 的配套 .dbf 这类"一个格式由多个文件组成"的场景用；
   * 与 `readBytes` 同样受根沙箱约束，插件不得自行拼绝对路径。
   */
  readSibling?: (rel: string) => Promise<Uint8Array>;
  /** 主题（插件按需切明暗）。 */
  theme: "dark" | "light";
  /** 缩放状态变化时回报（面板据此更新百分比显示）。 */
  onZoom?: (state: PreviewZoomState) => void;
  /** 分页文档回报"当前第几页/共几页"（状态栏显示，可点击跳转）。 */
  onPaging?: (state: { page: number; total: number }) => void;
  /** 字流文档回报"当前章节标题"（状态栏显示；比伪页码诚实）。 */
  onSection?: (title: string | null) => void;
}

/**
 * 面板工具条上的**声明式能力**：插件声明自己要哪些按钮，面板据此显示。
 * 新格式接入不用改面板 —— 声明 `zoom` 就自动有缩放控件。
 */
export type PreviewTool = "zoom" | "find" | "outline";

/**
 * 缩放动作。**没有"实际大小"**：百分比以「适应窗口」为 100% 的基准，
 * 100% 就是打开时的样子，"1:1 原始像素"对我们没有独立语义（还容易和 100% 打架）。
 */
export type ZoomAction = "in" | "out" | "fit" | "fit-width" | "fit-page";

/** 插件回报的缩放状态（面板显示百分比；`fit` 表示当前是"适应窗口"）。 */
export interface PreviewZoomState {
  percent: number;
  fit: boolean;
  /** 正处在哪个「适应」口径上（面板在菜单里打勾）。 */
  mode?: "width" | "page" | null;
}

/** 大纲条目：面板侧栏直接用它渲染（与 Markdown 的大纲同一套 UI）。 */
export interface PreviewOutlineItem {
  /** 层级（1 基，1 = 顶层）。 */
  level: number;
  title: string;
  /** 跳转目标，由插件自己解释（PDF 是页码）。 */
  target: number;
}

export interface PreviewFindOptions {
  /** true = 往后找，false = 往前找（含回绕）。 */
  forward: boolean;
  caseSensitive?: boolean;
  /** 正则查找（无效正则按"无命中"处理，不抛错）。 */
  regexp?: boolean;
  /** 整词匹配（拉丁文有意义；中文无词边界，等同普通匹配）。 */
  wholeWord?: boolean;
}

export interface PreviewFindResult {
  total: number;
  /** 当前命中序号（1 基；0 = 无命中）。 */
  current: number;
}

export interface PreviewInstance {
  /** 释放资源（object URL、worker、事件监听）。 */
  destroy?: () => void;
  /** 缩放（仅当插件声明了 `tools: ["zoom"]` 时面板才会调）。 */
  zoom?: (action: ZoomAction) => void;
  /** 文档结构（仅当声明 `tools: ["outline"]`；没有目录时给空数组）。 */
  outline?: PreviewOutlineItem[];
  /** 大纲跳转（target 与 outline 条目里的一致）。 */
  reveal?: (target: number) => void;
  /** 查找（仅当声明 `tools: ["find"]`）；首次调用可能要建全文索引，所以是异步的。 */
  find?: (query: string, options: PreviewFindOptions) => Promise<PreviewFindResult>;
  /** 清空查找高亮。 */
  findClear?: () => void;
}

/** 插件对"能不能预览这个文件"的回答。 */
export interface PreviewPlugin {
  id: string;
  /** 扩展名集合（小写、不含点）。 */
  extensions?: string[];
  /**
   * 文件头判定（可选）——**只服务 magic 通道**：扩展名未命中时，用它认领
   * 无扩展名 / 改名的文件。注意别再拿它挡自己的扩展名：同一插件名下的扩展名
   * 未必都是同一种容器（如 sheet 里的 `csv` 不是 zip、gis 里只有 `kmz` 是 zip），
   * 一刀切会把 `.csv`/`.geojson` 这类文本格式从自己家里踢出去。
   * 需要"扩展名相同、容器不同"的排他判定时，用 `headGuarded` 精确点出那几个。
   */
  matchHead?: (head: Uint8Array, file: PreviewFileInfo) => boolean;
  /**
   * 需要**先过 `matchHead` 才认**的扩展名（默认空 = 该插件名下扩展名一律直接认领）。
   * 例：`pdf` 要防"扩展名是 pdf、内容其实是 zip"；`kmz` 要防同名 zip。
   */
  headGuarded?: string[];
  /** 该格式支持的面板工具（缺省 = 无）。 */
  tools?: PreviewTool[];
  /**
   * 该格式的「适应」口径。给两个时面板把"适应"按钮做成下拉（适应宽度 / 适应页面）；
   * 第一个是**基准**（它的相对值 = 100%）。文档类给 `["width", "page"]`，
   * 图片/CAD/3D 用默认的单个 `page`。
   */
  zoomModes?: ("width" | "page")[];
  /** 实际渲染。 */
  render: (ctx: PreviewContext) => Promise<PreviewInstance | void>;
}

interface RegistryEntry {
  /** 动态加载（同一个 id 只加载一次）。 */
  load: () => Promise<PreviewPlugin>;
  /** 便于测试与文档：该条目声称支持的扩展名与 magic 说明。 */
  describe: { id: string; extensions?: string[]; head?: string[] };
}

const entries: RegistryEntry[] = [];

/** 注册一个格式（仅声明加载器；真正的插件模块按需加载）。 */
export function registerPreview(entry: RegistryEntry): void {
  entries.push(entry);
}

/**
 * 文件头字节（最多 1KB）——magic 判定用。
 * 与扩展名判定分开，避免"总是多读一次文件"。
 */
export async function readHead(readBytes: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const bytes = await readBytes();
  return bytes.subarray(0, 1024);
}

/** 扩展名 → 候选条目（可能多个，比如 zip 既可能是压缩包也可能是 docx）。 */
function candidatesFor(ext: string): RegistryEntry[] {
  return entries.filter((entry) => entry.describe.extensions?.includes(ext));
}

export interface ResolvedPreview {
  plugin: PreviewPlugin;
  id: string;
}

/**
 * 解析该用哪个插件渲染。
 *
 * 顺序：① 扩展名命中的条目逐个问 `matchHead`（多数没有），② 都不认则拿 `head` 问所有声明了
 * magic 的条目。返回 null = 没有插件能处理（宿主给"暂不支持 + 用默认应用打开"的诚实卡片）。
 */
export async function resolvePreview(
  file: PreviewFileInfo,
  readBytes: () => Promise<Uint8Array>,
): Promise<ResolvedPreview | null> {
  const byExt = candidatesFor(file.ext);
  const headCache: { value?: Uint8Array } = {};
  const head = async () => (headCache.value ??= await readHead(readBytes));

  for (const entry of byExt) {
    const plugin = await entry.load();
    const guarded = plugin.headGuarded?.includes(file.ext) ?? false;
    if (!guarded) return { plugin, id: plugin.id };
    if (plugin.matchHead?.(await head(), file)) return { plugin, id: plugin.id };
    // 扩展名被"占"了但内容不是它的（如 fake.pdf 其实是 zip）→ 继续往下问 magic 通道
  }
  // magic 通道按注册顺序取第一个认领者：因此**zip 家族必须先注册 archive**，
  // 否则 epub/xps/xmind/kmz 这些也是 zip 的格式会抢先认领陌生 zip 文件。
  for (const entry of entries) {
    if (byExt.includes(entry) || !entry.describe.head?.length) continue;
    const plugin = await entry.load();
    if (plugin.matchHead?.(await head(), file)) return { plugin, id: plugin.id };
  }
  return null;
}

/** 已注册格式（测试与文档用）。 */
export function registeredPreviews(): RegistryEntry["describe"][] {
  return entries.map((entry) => entry.describe);
}

/** 供面板头显示"这是什么格式"（与插件无关的粗分类）。 */
export function kindOf(entry: Pick<KbEntry, "name" | "kind">): "dir" | "file" {
  return entry.kind === "dir" ? "dir" : "file";
}
