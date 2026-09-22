/**
 * Typed wrappers over the Rust command surface.
 *
 * `isTauri()` lets the same app run in a plain browser during quick UI
 * iteration — commands are unavailable there and guarded at call sites.
 */
import { invoke, type Channel } from "@tauri-apps/api/core";
import type {
  Comment,
  GitBranchRow,
  GitCommitRow,
  GitHistoryPage,
  HealthInfo,
  Issue,
  IssueState,
  Pull,
  PullState,
  RepoInfo,
} from "./types";

// ---- Projects 看板（应用级，P4）----

/** 每日提交计数（镜像 models.rs::CommitDayCount）。 */
export interface CommitDayCount {
  /** 本地日期 YYYY-MM-DD（按提交者时区偏移归日）。 */
  date: string;
  count: number;
}

/** 日历订阅行（镜像 calendar.rs::FeedRow）。url 属准凭据：只回显，不进日志。 */
export interface CalendarFeed {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  /** 缓存事件数；null = 从未同步。 */
  cachedCount: number | null;
  /** 事件色 #RRGGBB；null = 默认样式。 */
  color: string | null;
}

/** 订阅缓存事件（启用的订阅聚合）。 */
export interface CalendarFeedEvent {
  feedId: string;
  feedName: string;
  date: string;
  title: string;
}

/** 日程行（镜像 calendar.rs::EventRow，app_010 calendar_events）。 */
export interface CalendarEventRow {
  id: string;
  title: string;
  /** YYYY-MM-DD。 */
  startDate: string;
  /** null = 单日。 */
  endDate: string | null;
  /** true = 全天（忽略时刻字段）。 */
  allDay: boolean;
  /** HH:MM（有时刻日程必有）。 */
  startTime: string | null;
  /** HH:MM 可选。 */
  endTime: string | null;
  /** "" = 不重复；daily / weekly / monthly / yearly（按起始日锚定）。 */
  recur: string;
  notes: string | null;
  /** null = 不提醒；datetime-local 形态。 */
  remindAt: string | null;
  /** 通知已发标记（通知层回写）。 */
  remindedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 农历日格标签（附结构化农历月日——每年农历重复的匹配依据）。 */
export interface LunarLabel {
  date: string;
  text: string;
  /** 农历月 1–12（闰月不叠加）。 */
  month: number;
  /** 农历日 1–30。 */
  day: number;
  leap: boolean;
}

/** 单日结构化农历。 */
export interface LunarYmd {
  month: number;
  day: number;
  leap: boolean;
}

/** 里程碑元数据（镜像 models.rs::MilestoneInfo，camelCase）。 */
export interface MilestoneInfo {
  number: number;
  title: string;
  description: string | null;
  dueOn: string | null;
  state: string;
  openIssues: number;
  closedIssues: number;
  htmlUrl: string | null;
}

/** 仓库标签（创建 Issue 的侧栏候选，镜像 models.rs::LabelInfo）。 */
export interface LabelInfo {
  id: number;
  name: string;
  /** hex 主题色（可能缺 # 前缀）。 */
  color: string | null;
}

export interface FieldOption {
  /** 选项说明（显示在组头与取值面板）；旧数据可能缺省。 */
  description?: string | null;
  id: string;
  name: string;
  color: string;
}

export interface Project {
  id: string;
  displayName: string;
  description: string | null;
  groupTag: string | null;
  /** 归属接入（切换项目对话框按它分 Tab）；null = 本地。 */
  connectionId: string | null;
  /** 平台绑定（导入线上 Projects 时记录；null = 纯本地项目）。 */
  platformKind: string | null;
  platformHost: string | null;
  platformRef: string | null;
  /** 项目数据最近同步时间（拉取线上 Projects 条目后盖章；null = 从未同步）。 */
  syncedAt: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectField {
  id: string;
  projectId: string;
  kind: "builtin_status" | "single_select" | "text" | "number" | "date";
  name: string;
  options: FieldOption[];
  position: number;
}

export interface ProjectItem {
  id: string;
  projectId: string;
  kind: "issue" | "pull" | "draft";
  repoId: string | null;
  /** 平台引用快照（origin_url + 来源类型）：导入未命中时留档，登记后据此回填。 */
  originUrl: string | null;
  originType: string | null;
  number: string | null;
  draftTitle: string | null;
  draftBody: string | null;
  rank: string;
  addedAt: string;
  /** 归档时间戳（null = 未归档）。归档 = 移出所有视图但保留条目上下文
   *  （对齐 GitHub Projects 的 Archive）；视图侧统一按它排除。 */
  archivedAt: string | null;
  repoLabel: string | null;
  ghost: boolean;
  fieldValues: Record<string, string>;
  /** 引用实体的镜像元数据（仓库缓存里的 Issue/PR 行）；草稿/未关联/未同步为 null。 */
  entity?: ProjectEntityMeta | null;
}

/** Issue 关系数据（依赖 / 父子 / 子 Issue 进度）——详情级按需拉取。
 *  能力矩阵见知识库《架构设计-项目甘特图》§4.2：GitHub 全有；Gitea 仅
 *  blocking（blocks 端点方向映射）；Gitee/本地恒空（前端诚实不显示）。 */
export interface IssueRelations {
  blockedBy: IssueRef[];
  blocking: IssueRef[];
  parent?: IssueRef | null;
  subIssues: IssueRef[];
  subSummary?: SubIssueSummary | null;
}

export interface IssueRef {
  number: string;
  title: string;
  /** "OPEN" | "CLOSED"（各家归一）。 */
  state: string;
}

export interface SubIssueSummary {
  total: number;
  completed: number;
}

/** 引用实体（Issue/PR）的只读元数据。 */
export interface ProjectEntityMeta {
  title: string;
  state: string;
  author: string | null;
  assignees: string[];
  labels: string[];
  milestone: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** 项目绑定的仓库（接入配置标签随 repos 行携带）。 */
/** 甘特依赖边：itemId 依赖 dependsOn（FS）。origin NULL = 容器真源。 */
export interface ItemDep {
  itemId: string;
  dependsOn: string;
  origin: string | null;
}

/** 资源目录条目（《架构设计-甘特计划面》§5-bis，照 jordium Resource 形状）。
 *  origin NULL = 本地自定义；'gh'/'gitea' = 平台负责人派生镜像。 */
export interface Resource {
  id: string;
  name: string;
  title?: string | null;
  /** Human | Device | Others | 自定义 */
  type: string;
  department?: string | null;
  /** 每日标准工时（小时）；null = 全局默认 */
  capacity?: number | null;
  color?: string | null;
  origin: string | null;
}

/** 分配：条目占用资源 allocation%（20–100，照 jordium 抽屉口径 clamp）。 */
export interface ItemResource {
  itemId: string;
  resourceId: string;
  allocation: number;
  origin: string | null;
}

/** 资源级工作日历例外（请假 / 设备停机）。 */
export interface ResourceException {
  id: string;
  resourceId: string | null;
  name: string | null;
  startAt: string;
  endAt: string;
  /** true = 额外计工时（加班/补班）；false = 不计工时（请假/停机） */
  working: boolean;
}

/** 父子边（结构扩展泳道）：itemId 的上级 = parentId。origin NULL = 容器真源。 */
export interface ItemParent {
  itemId: string;
  parentId: string;
  origin: string | null;
}

/** 镜像同步输入边。 */
export interface ItemDepInput {
  itemId: string;
  dependsOn: string;
}

/** 每日滚动备份状态（《架构设计-导出与导入》推论：主库没有 git 真源）。 */
export interface BackupStatus {
  dir: string;
  count: number;
  /** 最近一份备份文件名（还没备份过 = null）。 */
  latest: string | null;
}

/** 导入预览的整体结果：版本对照 + 本机缺失仓库 + 逐项目行。 */
export interface ImportPreviewResult {
  packSchemaVersion: number;
  localSchemaVersion: number;
  /** 包来自更旧的应用版本（能读，但值得提示一句）。 */
  packIsOlder: boolean;
  /** 包引用了、本机登记表里没有的仓库（引导逐个打开 / clone）。 */
  missingRepos: { originUrl: string | null; sourceType: string | null }[];
  projects: ImportPreview[];
}

/** 每日计数快照（项目分析：燃起图的唯一数据来源；见 app_017）。 */
export interface ProjectSnapshot {
  /** YYYY-MM-DD（本地日）。 */
  day: string;
  total: number;
  /** 状态选项 id → 计数。 */
  status: Record<string, number>;
  /** 状态选项 id → 当时的名字（选项后来改名/删除，历史仍可读）。 */
  labels: Record<string, string>;
}

/** 导入三选一：新增 / 覆盖（包较新）/ 保留（本机较新）。Rust 侧按小写序列化。 */
export type ImportAction = "add" | "overwrite" | "keep";

/** 导入预览的一行（每项目一行；suggestion = 系统预选项）。 */
export interface ImportPreview {
  id: string;
  name: string;
  localUpdatedAt: string | null;
  packUpdatedAt: string;
  suggestion: ImportAction;
  items: number;
  fields: number;
}

export interface BoundRepo {
  repoId: string;
  label: string;
  platform: string;
  connectionLabel: string | null;
  /** 本地克隆 = path；仅远端 = remote_url；悬挂绑定 = 空串。 */
  target: string;
  ghost: boolean;
}

/** 线上仓库清单条目（跨平台归一）。 */
export interface RemoteRepoInfo {
  fullName: string;
  url: string;
  description: string | null;
  updatedAt: string | null;
}

// ---- 本地分支 review ----

export interface ReviewBranch {
  name: string;
  isCurrent: boolean;
  ahead: number;
  behind: number;
  shortId: string;
}

export interface ReviewFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface BranchReviewDiff {
  base: string;
  head: string;
  upToDate: boolean;
  mergeable: boolean;
  conflict: boolean;
  commits: Array<{
    oid: string;
    parents: string[];
    message: string;
    author?: string | null;
    committedAtUnix: number;
  }>;
  files: ReviewFile[];
  truncated: boolean;
}

export const isTauri = (): boolean => "__TAURI_INTERNALS__" in window;

/** 知识库图谱索引（镜像 src-tauri/src/kb_graph.rs）。 */
export interface KbGraphNode {
  /** 唯一 id = 库内相对路径。 */
  id: string;
  /** 首个 H1，缺省文件名去扩展名。 */
  title: string;
  /** 顶层目录（着色维度）；根下文件为 null。 */
  folder: string | null;
  /** 标签（frontmatter `tags:` + 行内 `#tag`，去重排序）——筛选维度。 */
  tags: string[];
}

export interface KbGraphLink {
  source: string;
  target: string;
}

export interface KbGraphIndex {
  nodes: KbGraphNode[];
  links: KbGraphLink[];
  /** 有引用但无唯一对应文件（未建或同名歧义）。 */
  unresolved: string[];
  /** md 文件数超上限，图为局部。 */
  truncated: boolean;
}

// ---- 知识库（文件系统层，镜像 src-tauri/src/kb.rs）----

/** 一条搜索命中（1 基行/列；列按**字符**计，中文场景不能用字节偏移）。 */
export interface KbSearchHit {
  rel: string;
  line: number;
  column: number;
  text: string;
}

export interface KbSearchResult {
  hits: KbSearchHit[];
  /** 命中文件数。 */
  files: number;
  /** 达到上限被截断（界面提示"还有更多"）。 */
  truncated: boolean;
}

export interface KbEntry {
  name: string;
  /** 相对根的路径，`/` 分隔——树的前端 key。 */
  rel: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtimeMs: number;
  /** `.gitignore` 命中：灰显，不隐藏。 */
  ignored: boolean;
}

export interface KbText {
  text: string;
  /** 规范化编码名（UTF-8 / GB18030 / BIG5 / UTF-16LE …）——保存时按它回写。 */
  encoding: string;
  bom: boolean;
  eol: string;
  size: number;
  mtimeMs: number;
}

export interface KbStat {
  exists: boolean;
  kind: string;
  size: number;
  mtimeMs: number;
}

/** 「打开方式」偏好（镜像 src-tauri/src/kb.rs::OpenWithPrefs）。 */
export interface OpenWithPrefs {
  /**
   * 扩展名（小写、不含点）→ 应用。
   *
   * 值优先是 `.app` / `.exe` 的**绝对路径**（从系统应用列表里选的），也兼容早期手填的
   * 应用名 —— `open -a` 两种都认。
   */
  byExt: Record<string, string>;
}

/** 系统里的一个应用（镜像 src-tauri/src/openwith_apps.rs::AppInfo）。 */
export interface SystemApp {
  /** 显示名（Info.plist 的 CFBundleDisplayName / CFBundleName）。 */
  name: string;
  /** 绝对路径（.app）—— 存这个，避免同名歧义。 */
  path: string;
  /** 该应用在 Info.plist 里声明的扩展名（小写、不含点）；空 = 没声明。 */
  extensions?: string[];
}

/** 某个扩展名的系统登记情况（Finder「打开方式」那张表）。 */
export interface ExtApps {
  /** 系统默认应用；系统没登记该扩展名时为 null。 */
  default: SystemApp | null;
  /** 候选应用（默认应用不在其中）。 */
  candidates: SystemApp[];
}

export const api = {
  healthCheck: () => invoke<HealthInfo>("health_check"),
  pickRepo: () => invoke<string | null>("pick_repo"),
  kbPickRoot: () => invoke<string | null>("kb_pick_root"),
  kbListDir: (root: string, rel = "", showIgnored = false) =>
    invoke<KbEntry[]>("kb_list_dir", { root, rel, showIgnored }),
  /** 遍历整根拿全部文件（⌘P 快速打开）——一次 IPC，比前端逐层拉快得多。 */
  kbWalk: (root: string, showIgnored = false, limit?: number) =>
    invoke<string[]>("kb_walk", { root, showIgnored, limit }),
  /** 图谱索引：一次 IPC 拿全图 {nodes, links, unresolved}（派生数据，不落盘）。 */
  kbGraphIndex: (root: string) => invoke<KbGraphIndex>("kb_graph_index", { root }),
  /** 图谱记忆布局（app.db prefs，键按 kb 根指纹；JSON `{rel: [x, y]}`）。 */
  kbGraphLayoutGet: (root: string) => invoke<string | null>("kb_graph_layout_get", { root }),
  kbGraphLayoutSet: (root: string, layoutJson: string) =>
    invoke<void>("kb_graph_layout_set", { root, layoutJson }),
  /** 启动知识库根的改动监听（2s 轮询；换根时重复调用即替换旧 watcher）。 */
  kbWatchStart: (root: string) => invoke<void>("kb_watch_start", { root }),
  /** 停止改动监听（切走知识库工作区时调用）。 */
  kbWatchStop: () => invoke<void>("kb_watch_stop"),
  /** 让系统生成预览图（Quick Look）；失败返回 null（不抛，调用方按"没有"处理）。 */
  kbThumbnail: (root: string, rel: string, size = 640) =>
    invoke<ArrayBuffer>("kb_thumbnail", { root, rel, size }).catch(() => null),
  /** 全文搜索（Rust 侧按行搜，编码探测后再匹配，GBK 中文也搜得到）。 */
  kbSearch: (root: string, query: string, showIgnored = false, maxHits?: number) =>
    invoke<KbSearchResult>("kb_search", { root, query, showIgnored, maxHits }),
  kbStat: (root: string, rel = "") => invoke<KbStat>("kb_stat", { root, rel }),
  kbReadText: (root: string, rel: string, encoding?: string) =>
    invoke<KbText>("kb_read_text", { root, rel, encoding }),
  /** 二进制预览：Rust 侧用 ipc::Response 回原始字节，这里拿到的是 ArrayBuffer。 */
  kbReadBytes: (root: string, rel: string) => invoke<ArrayBuffer>("kb_read_bytes", { root, rel }),
  /** 保编码回写；返回写入后的 mtime。mtime 不符（外部改动）→ 报错。 */
  kbWriteText: (args: {
    root: string;
    rel: string;
    text: string;
    encoding: string;
    bom: boolean;
    eol: string;
    expectedMtimeMs: number | null;
  }) => invoke<number>("kb_write_text", args),
  /** 写入二进制（粘贴/拖放插图、图片编辑回写）：base64 传参，父目录自动创建。
   *  `expectedMtimeMs` 不符（外部改动）→ 报错，与 kbWriteText 同一守卫。 */
  kbWriteBytes: (root: string, rel: string, base64: string, expectedMtimeMs?: number | null) =>
    invoke<KbEntry>("kb_write_bytes", { root, rel, base64, expectedMtimeMs: expectedMtimeMs ?? null }),
  /** 重命名（同根内；目标已存在则报错，不覆盖）。 */
  kbRename: (root: string, from: string, to: string) =>
    invoke<KbEntry>("kb_rename", { root, from, to }),
  /** 复制（保留源；目录递归）。 */
  kbCopy: (root: string, from: string, to: string) => invoke<KbEntry>("kb_copy", { root, from, to }),
  /** 移动（跨目录搬；目录亦可）。 */
  kbMove: (root: string, from: string, to: string) => invoke<KbEntry>("kb_move", { root, from, to }),
  /** 单文件提交历史（Rust 侧 revwalk + diff pathspec 过滤）。 */
  gitFileHistory: (root: string, rel: string, limit = 100) =>
    invoke<GitHistoryPage>("git_file_history", { root, rel, limit }),
  /** 删除（**进系统回收站**，失败才退永久删除）。 */
  kbDelete: (root: string, rel: string) => invoke<void>("kb_delete", { root, rel }),
  /** 新建空文件 / 目录；已存在则报错（不覆盖）。 */
  kbCreate: (root: string, rel: string, kind: "file" | "dir") =>
    invoke<KbEntry>("kb_create", { root, rel, kind }),
  /** 「打开方式」偏好（存 app.db：打开动作由 Rust 执行，配置也由 Rust 持有）。 */
  kbPickApp: () => invoke<string | null>("kb_pick_app"),
  /** 已安装应用清单（扫标准应用目录 + 读 Info.plist；系统给什么就是什么）。 */
  kbAppsList: () => invoke<SystemApp[]>("kb_apps_list"),
  /** 这个扩展名在系统里"用什么打开"：默认应用 + 候选（= Finder「打开方式」子菜单）。 */
  kbAppsForExt: (ext: string) => invoke<ExtApps>("kb_apps_for_ext", { ext }),
  kbOpenPrefsGet: () => invoke<OpenWithPrefs>("kb_open_prefs_get"),
  kbOpenPrefsSet: (prefs: OpenWithPrefs) => invoke<void>("kb_open_prefs_set", { prefs }),
  /**
   * 用（配置的）外部程序打开知识库内的文件。
   * 注意**不能**走 `@tauri-apps/plugin-opener` 的 `openPath`：该命令内部强制 ACL scope
   * 校验，而其 fs scope 是编译期静态配置、空 allow 即全拒 → 必然 ForbiddenPath。
   * 这里由 Rust 侧解析要启动的程序（前端不指定，避免把打开文件变成任意程序启动入口）。
   */
  kbOpenExternal: (root: string, rel: string) => invoke<void>("kb_open_external", { root, rel }),
  repoInfo: (repoPath: string) =>
    invoke<RepoInfo>("repo_info", { repoPath }),
  refreshIssues: (repoPath: string, state: IssueState, limit = 50) =>
    invoke<Issue[]>("refresh_issues", { repoPath, state, limit }),
  // v1 仅本地仓库（journal + SQLite）；远端创建后续接同一命令。
  createIssue: (repoPath: string, title: string, body?: string, milestone?: string, labels?: string[], assignees?: string[]) =>
    invoke<Issue>("create_issue", {
      repoPath,
      title,
      body: body ?? null,
      milestone: milestone ?? null,
      labels: labels ?? null,
      assignees: assignees ?? null,
    }),
  updateIssue: (repoPath: string, number: string, title: string, body?: string) =>
    invoke<Issue>("update_issue", { repoPath, number, title, body: body ?? null }),
  createMilestone: (repoPath: string, title: string, dueOn?: string, description?: string) =>
    invoke<string>("create_milestone", { repoPath, title, dueOn: dueOn ?? null, description: description ?? null }),
  listCachedIssues: (repoPath: string, state: IssueState) =>
    invoke<Issue[]>("list_cached_issues", { repoPath, state }),
  cachedIssueCount: (repoPath: string, state: IssueState) =>
    invoke<number>("cached_issue_count", { repoPath, state }),
  refreshPulls: (repoPath: string, state: PullState, limit = 50) =>
    invoke<Pull[]>("refresh_pulls", { repoPath, state, limit }),
  refreshPullDetail: (repoPath: string, number: number) =>
    invoke<Pull>("refresh_pull_detail", { repoPath, number }),
  listCachedPulls: (repoPath: string, state: PullState) =>
    invoke<Pull[]>("list_cached_pulls", { repoPath, state }),
  cachedPullCount: (repoPath: string, state: PullState) =>
    invoke<number>("cached_pull_count", { repoPath, state }),
  // issue 编号统一文本口径（Gitee v5 是字符串）；pull 编号保持数字。
  listCachedComments: (repoPath: string, kind: "issue" | "pull", number: string) =>
    invoke<Comment[]>("list_cached_comments", { repoPath, kind, number }),
  fetchComments: (repoPath: string, kind: "issue" | "pull", number: string) =>
    invoke<Comment[]>("fetch_comments", { repoPath, kind, number }),
  // Returns the fresh conversation — the write-through contract.
  addComment: (repoPath: string, kind: "issue" | "pull", number: string, body: string) =>
    invoke<Comment[]>("add_comment", { repoPath, kind, number, body }),
  /** 关闭/重开（reason ∈ completed | not planned | duplicate；重开传 null）。 */
  setIssueState: (repoPath: string, number: string, closed: boolean, reason?: string | null) =>
    invoke<Issue>("set_issue_state", { repoPath, number, closed, reason: reason ?? null }),
  /** 锁定/解锁讨论（gh/Gitea；本地 Err）。 */
  issueSetLocked: (repoPath: string, number: string, locked: boolean) =>
    invoke<void>("issue_set_locked", { repoPath, number, locked }),
  /** 删除 Issue（平台侧永久删除，需管理员；Gitea/本地 Err）。 */
  issueDelete: (repoPath: string, number: string) =>
    invoke<void>("issue_delete", { repoPath, number }),
  /** 挂/清里程碑（写穿透；null = 清除）。 */
  issueUpdateMilestone: (repoPath: string, number: string, milestone: string | null) =>
    invoke<Issue>("issue_update_milestone", { repoPath, number, milestone }),
  /** 整体替换标签（按名，写穿透）。 */
  issueUpdateLabels: (repoPath: string, number: string, labels: string[]) =>
    invoke<Issue>("issue_update_labels", { repoPath, number, labels }),
  /** 整体替换负责人（登录名，写穿透）。 */
  issueUpdateAssignees: (repoPath: string, number: string, assignees: string[]) =>
    invoke<Issue>("issue_update_assignees", { repoPath, number, assignees }),
  setPullState: (repoPath: string, number: number, closed: boolean) =>
    invoke<Pull>("set_pull_state", { repoPath, number, closed }),
  mergePull: (repoPath: string, number: number, method: "merge" | "squash" | "rebase") =>
    invoke<Pull>("merge_pull", { repoPath, number, method }),
  gitHistory: (repoPath: string, limit?: number) =>
    invoke<GitHistoryPage>("git_history", { repoPath, limit: limit ?? 500 }),
  prCommitsBetween: (repoPath: string, base: string, head: string) =>
    invoke<GitCommitRow[]>("pr_commits_between", { repoPath, base, head }),
  gitBranches: (repoPath: string) => invoke<GitBranchRow[]>("git_branches", { repoPath }),
  gitFetch: (repoPath: string) => invoke<void>("git_fetch", { repoPath }),
  /** 日历「提交热力」图层：HEAD + 本地分支的每日提交计数（窗口天，默认 365）。 */
  gitCommitActivity: (repoPath: string, days?: number) =>
    invoke<CommitDayCount[]>("git_commit_activity", { repoPath, days: days ?? null }),
  // ---- 日历 S3-b：ICS 订阅 / 内置假日 / 农历 ----
  calendarFeedList: () => invoke<CalendarFeed[]>("calendar_feed_list"),
  calendarFeedAdd: (name: string, url: string) =>
    invoke<CalendarFeed>("calendar_feed_add", { name, url }),
  calendarFeedRemove: (id: string) => invoke<void>("calendar_feed_remove", { id }),
  calendarFeedSetEnabled: (id: string, enabled: boolean) =>
    invoke<CalendarFeed>("calendar_feed_set_enabled", { id, enabled }),
  calendarFeedSetColor: (id: string, color: string | null) =>
    invoke<CalendarFeed>("calendar_feed_set_color", { id, color }),
  calendarFeedSync: (id: string) => invoke<number>("calendar_feed_sync", { id }),
  calendarFeedEvents: () => invoke<CalendarFeedEvent[]>("calendar_feed_events"),
  calendarLunarRange: (start: string, end: string) =>
    invoke<LunarLabel[]>("calendar_lunar_range", { start, end }),
  calendarLunarYmd: (date: string) => invoke<LunarYmd>("calendar_lunar_ymd", { date }),
  // ---- 日历 S4：日程（app.db 主库；本地通知层用 remindAt/remindedAt）----
  calendarEventList: () => invoke<CalendarEventRow[]>("calendar_event_list"),
  calendarEventCreate: (
    title: string,
    startDate: string,
    endDate?: string | null,
    allDay?: boolean,
    startTime?: string | null,
    endTime?: string | null,
    notes?: string | null,
    remindAt?: string | null,
    recur?: string,
  ) =>
    invoke<CalendarEventRow>("calendar_event_create", {
      title,
      startDate,
      endDate: endDate ?? null,
      allDay: allDay ?? true,
      startTime: startTime ?? null,
      endTime: endTime ?? null,
      notes: notes ?? null,
      remindAt: remindAt ?? null,
      recur: recur ?? "",
    }),
  calendarEventUpdate: (
    id: string,
    title: string,
    startDate: string,
    endDate?: string | null,
    allDay?: boolean,
    startTime?: string | null,
    endTime?: string | null,
    notes?: string | null,
    remindAt?: string | null,
    recur?: string,
  ) =>
    invoke<CalendarEventRow>("calendar_event_update", {
      id,
      title,
      startDate,
      endDate: endDate ?? null,
      allDay: allDay ?? true,
      startTime: startTime ?? null,
      endTime: endTime ?? null,
      notes: notes ?? null,
      remindAt: remindAt ?? null,
      recur: recur ?? "",
    }),
  calendarEventRemove: (id: string) => invoke<void>("calendar_event_remove", { id }),
  calendarEventSetReminded: (id: string, remindedAt: string | null) =>
    invoke<CalendarEventRow>("calendar_event_set_reminded", { id, remindedAt }),
  // 系统日历「导出出」：全部手建日程 → .ics 文件；返回条数。
  calendarExportIcs: (path: string) => invoke<number>("calendar_export_ics", { path }),
  ptySpawn: (args: {
    id: string;
    cwd?: string;
    shell?: string;
    rows: number;
    cols: number;
    onOutput: Channel<string>;
  }) => invoke<void>("pty_spawn", args),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, rows: number, cols: number) => invoke<void>("pty_resize", { id, rows, cols }),
  ptyKill: (id: string) => invoke<void>("pty_kill", { id }),
  connectionList: () => invoke<Array<{ id: string; platform: string; host: string; label: string; sourceState: string; createdAt: string }>>("connection_list"),
  connectionSave: (args: { id?: string; platform: string; host: string; label: string }) =>
    invoke<{ id: string; label: string }>("connection_save", args),
  connectionDelete: (id: string) => invoke<void>("connection_delete", { id }),
  repoList: () =>
    invoke<Array<{ id: string; path?: string | null; remoteUrl?: string | null; displayName?: string | null; connectionId?: string | null; connectionLabel?: string | null; platform?: string | null; visibility?: string | null; lastOpenedAt: string }>>("repo_list"),
  repoVisibility: (target: string) => invoke<string | null>("repo_visibility", { target }),
  repoRegister: (path: string) => invoke<unknown>("repo_register", { path }),
  repoRegisterRemote: (url: string, platform: string) =>
    invoke<unknown>("repo_register_remote", { url, platform }),
  repoDelete: (id: string) => invoke<void>("repo_delete", { id }),
  sourceConfigGet: () => invoke<{ giteaHost?: string | null }>("source_config_get"),
  sourceConfigSet: (config: { giteaHost?: string | null }) =>
    invoke<void>("source_config_set", { config }),
  credentialSet: (platform: string, token: string) => invoke<void>("credential_set", { platform, token }),
  credentialGet: (platform: string) => invoke<string | null>("credential_get", { platform }),
  credentialDelete: (platform: string) => invoke<void>("credential_delete", { platform }),
  logLine: (level: "error" | "warn" | "info" | "debug", message: string) =>
    invoke<void>("log_line", { level, message }).catch(() => {}),
  listSyncedAt: (repoPath: string) =>
    invoke<[string, string][]>("list_synced_at", { repoPath }),
  probeNetwork: () => invoke<void>("probe_network"),

  // ---- Projects 看板 ----
  projectCreate: (name: string, description?: string, connectionId?: string) =>
    invoke<Project>("project_create", { name, description: description ?? null, connectionId: connectionId ?? null }),
  projectList: (includeArchived = false) =>
    invoke<Project[]>("project_list", { includeArchived }),
  projectUpdate: (id: string, name: string, description?: string) =>
    invoke<Project>("project_update", { id, name, description: description ?? null }),
  projectArchive: (id: string, archived: boolean) =>
    invoke<void>("project_archive", { id, archived }),
  projectDelete: (id: string) => invoke<void>("project_delete", { id }),
  projectFields: (projectId: string) =>
    invoke<ProjectField[]>("project_fields", { projectId }),
  projectFieldSetOptions: (fieldId: string, options: FieldOption[]) =>
    invoke<void>("project_field_set_options", { fieldId, options }),
  /** 追加一个选项（新建列 / 新建泳道段）：id 与颜色由后端定。 */
  projectFieldOptionAdd: (fieldId: string, name: string, color?: string) =>
    invoke<ProjectField>("project_field_option_add", { fieldId, name, color: color ?? null }),
  /** 新建项目字段（single_select | text | number | date）；选项名由后端配 id 与颜色。 */
  /** 另存文本（视图数据 CSV 导出）：取消返回 null。 */
  saveTextFile: (defaultName: string, contents: string) =>
    invoke<string | null>("save_text_file", { defaultName, contents }),
  /** 工作内容级 UI 偏好（app.db prefs 表的 ui. 命名空间）——见 src/ui-prefs.ts。 */
  uiPrefsGetAll: () => invoke<[string, string][]>("ui_prefs_get_all"),
  uiPrefsSet: (key: string, value: string) => invoke<void>("ui_prefs_set", { key, value }),
  uiPrefsRemove: (key: string) => invoke<void>("ui_prefs_remove", { key }),
  /** 应用数据目录（「家在哪」；设置页展示 + 启动日志）。 */
  appDataPath: () => invoke<string>("app_data_path"),
  /** 读文本文件（设备包导入）：路径来自系统文件选择器。 */
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  /** 每日备份状态（设置面板展示）。 */
  backupStatus: () => invoke<BackupStatus>("backup_status"),
  /** 立即打一份备份（同日已有则返回既有路径）。 */
  backupNow: () => invoke<string>("backup_now"),
  /** 导出设备包（projectIds 省略 = 全部项目）：返回 JSON 文本，交给 saveTextFile 落盘。 */
  exportPack: (projectIds?: string[]) => invoke<string>("export_pack", { projectIds: projectIds ?? null }),
  /** 导入预览：版本闸 + 本机缺失仓库 + 按项目 uuid 给系统建议（新增 / 覆盖 / 保留）。 */
  importPreview: (packJson: string) => invoke<ImportPreviewResult>("import_preview", { packJson }),
  /** 应用导入（覆盖前后端自动打快照）；返回 [新增, 覆盖, 保留]。 */
  importApply: (packJson: string, decisions: Record<string, ImportAction>) =>
    invoke<[number, number, number]>("import_apply", { packJson, decisions }),
  projectFieldCreate: (projectId: string, name: string, kind: string, optionNames: string[]) =>
    invoke<ProjectField>("project_field_create", { projectId, name, kind, optionNames }),
  projectItemAdd: (args: {
    projectId: string;
    kind: "issue" | "pull" | "draft";
    repoId?: string;
    number?: string;
    draftTitle?: string;
    draftBody?: string;
  }) =>
    invoke<ProjectItem>("project_item_add", {
      projectId: args.projectId,
      kind: args.kind,
      repoId: args.repoId ?? null,
      number: args.number ?? null,
      draftTitle: args.draftTitle ?? null,
      draftBody: args.draftBody ?? null,
    }),
  projectItemList: (projectId: string) =>
    invoke<ProjectItem[]>("project_item_list", { projectId }),
  projectItemMove: (
    itemId: string,
    fieldId?: string,
    optionId?: string,
    prevId?: string,
    nextId?: string,
  ) =>
    invoke<ProjectItem>("project_item_move", {
      itemId,
      fieldId: fieldId ?? null,
      optionId: optionId ?? null,
      prevId: prevId ?? null,
      nextId: nextId ?? null,
    }),
  projectItemRemove: (itemId: string) => invoke<void>("project_item_remove", { itemId }),
  /** 条目归档 / 还原（archived=true 归档，false 还原）；视图侧默认排除归档项。 */
  projectItemArchive: (itemId: string, archived: boolean) =>
    invoke<void>("project_item_archive", { itemId, archived }),
  /** 采集/刷新当天快照（同日覆盖，幂等）。 */
  projectSnapshotTake: (projectId: string) => invoke<ProjectSnapshot>("project_snapshot_take", { projectId }),
  /** 最近 N 天的快照（升序，直接铺图）。 */
  projectSnapshotList: (projectId: string, days: number) =>
    invoke<ProjectSnapshot[]>("project_snapshot_list", { projectId, days }),
  /** 回填未关联条目（按 origin 快照挂回登记表）；返回挂接条数。 */
  projectRelinkOrigin: (projectId: string) => invoke<number>("project_relink_origin", { projectId }),
  projectItemUpdateDraft: (itemId: string, title: string, body?: string) =>
    invoke<ProjectItem>("project_item_update_draft", { itemId, title, body: body ?? null }),
  projectFieldValueSet: (itemId: string, fieldId: string, value?: string) =>
    invoke<void>("project_field_value_set", { itemId, fieldId, value: value ?? null }),
  convertDraftToIssue: (itemId: string, repoPath: string) =>
    invoke<ProjectItem>("convert_draft_to_issue", { itemId, repoPath }),
  projectRepoBind: (projectId: string, repoId: string) =>
    invoke<void>("project_repo_bind", { projectId, repoId }),
  projectRepoUnbind: (projectId: string, repoId: string) =>
    invoke<void>("project_repo_unbind", { projectId, repoId }),
  projectRepoList: (projectId: string) =>
    invoke<BoundRepo[]>("project_repo_list", { projectId }),
  /** 甘特依赖边（容器真源泳道；《架构设计-甘特计划面》§3–4）。
   *  add/remove 的环检测与归属校验在 Rust 侧权威执行。 */
  projectDepList: (projectId: string) =>
    invoke<ItemDep[]>("project_dep_list", { projectId }),
  projectDepAdd: (projectId: string, itemId: string, dependsOn: string) =>
    invoke<void>("project_dep_add", { projectId, itemId, dependsOn }),
  projectDepRemove: (projectId: string, itemId: string, dependsOn: string) =>
    invoke<void>("project_dep_remove", { projectId, itemId, dependsOn }),
  /** 平台镜像行整组同步（甘特计划面 §4：离线可读）；真源行不触碰。 */
  projectDepSyncPlatform: (projectId: string, origin: string, edges: ItemDepInput[]) =>
    invoke<void>("project_dep_sync_platform", { projectId, origin, edges }),
  /** 父子（结构扩展泳道，§3）：上级任务 = app.db 本地真源（容器是我们排的计划）。
   *  set 的环检测与归属校验在 Rust 侧权威执行。 */
  projectParentList: (projectId: string) =>
    invoke<ItemParent[]>("project_parent_list", { projectId }),
  projectParentSet: (projectId: string, itemId: string, parentId: string) =>
    invoke<void>("project_parent_set", { projectId, itemId, parentId }),
  projectParentClear: (projectId: string, itemId: string) =>
    invoke<void>("project_parent_clear", { projectId, itemId }),
  projectParentSyncPlatform: (projectId: string, origin: string, edges: ItemDepInput[]) =>
    invoke<void>("project_parent_sync_platform", { projectId, origin, edges }),
  /** 资源目录（跨项目共享；§5-bis）与分配、资源级日历例外。 */
  resourceList: () => invoke<Resource[]>("resource_list"),
  resourceUpsert: (resource: Resource) => invoke<void>("resource_upsert", { resource }),
  resourceRemove: (resourceId: string) => invoke<void>("resource_remove", { resourceId }),
  /** 平台负责人 → 资源目录镜像（幂等；本地同名优先不覆盖）。 */
  resourceSyncAssignees: (origin: string, logins: string[]) =>
    invoke<number>("resource_sync_assignees", { origin, logins }),
  itemResourceList: (projectId: string) => invoke<ItemResource[]>("item_resource_list", { projectId }),
  itemResourceSet: (projectId: string, itemId: string, resourceId: string, allocation: number) =>
    invoke<void>("item_resource_set", { projectId, itemId, resourceId, allocation }),
  itemResourceRemove: (projectId: string, itemId: string, resourceId: string) =>
    invoke<void>("item_resource_remove", { projectId, itemId, resourceId }),
  resourceExceptionList: (resourceId: string) =>
    invoke<ResourceException[]>("resource_exception_list", { resourceId }),
  resourceExceptionUpsert: (exception: ResourceException) =>
    invoke<void>("resource_exception_upsert", { exception }),
  resourceExceptionRemove: (id: string) => invoke<void>("resource_exception_remove", { id }),
  /** 线上仓库清单（按接入凭据拉取，用于「刷新从线上查找」）。 */
  /** 拉取线上 Projects 条目落本地看板；返回 [imported, skipped]。 */
  projectSyncItems: (projectId: string) =>
    invoke<[number, number]>("project_sync_items", { projectId }),
  /** 把本地列（单选字段选项表）发布到线上项目；返回发布的字段数。 */
  projectPublishColumns: (projectId: string) =>
    invoke<number>("project_publish_columns", { projectId }),
  /** 导入线上 Projects 为本地项目（记录平台绑定；name 由调用方给）。 */
  projectImportRemote: (args: {
    name: string;
    connectionId?: string | null;
    platformKind: string;
    platformHost: string;
    platformRef: string;
  }) =>
    invoke<Project>("project_import_remote", {
      name: args.name,
      connectionId: args.connectionId ?? null,
      platformKind: args.platformKind,
      platformHost: args.platformHost,
      platformRef: args.platformRef,
    }),
  /** 线上 ProjectsV2 清单（GitHub；需 token 具备 read:project scope）。 */
  remoteProjectList: (limit?: number) =>
    invoke<
      { number: number; title: string; url: string; closed: boolean }[]
    >("remote_project_list", { limit: limit ?? null }),
  remoteRepoList: (platform: string, host: string) =>
    invoke<RemoteRepoInfo[]>("remote_repo_list", { platform, host }),

  // ---- GitHub 认证（Device Flow；凭据归 gh 托管）----
  ghDeviceFlowStart: () =>
    invoke<{ userCode: string; verificationUri: string; deviceCode: string; intervalSecs: number }>(
      "gh_device_flow_start",
    ),
  ghDeviceFlowPoll: (deviceCode: string, intervalSecs: number) =>
    invoke<string>("gh_device_flow_poll", { deviceCode, intervalSecs }),
  ghAuthWithToken: (token: string) => invoke<string>("gh_auth_with_token", { token }),
  ghAuthUser: () => invoke<string | null>("gh_auth_user"),

  // ---- Issue/PR 创建（写穿透）----
  createPull: (repoPath: string, head: string, base: string, title: string, body?: string) =>
    invoke<Pull>("create_pull", { repoPath, head, base, title, body: body ?? null }),
  remoteBranchList: (repoPath: string) =>
    invoke<string[]>("remote_branch_list", { repoPath }),

  // ---- 里程碑元数据（组头 Due by / Overdue、里程碑详情的数据源）----
  milestoneList: (repoPath: string) =>
    invoke<MilestoneInfo[]>("milestone_list", { repoPath }),
  /** Issue 关系（依赖/父子/子 Issue）；无能力的来源返回全空。 */
  issueRelations: (repoPath: string, number: string) =>
    invoke<IssueRelations>("issue_relations", { repoPath, number }),
  /** 批量关系（甘特整板装载）：编号 → 关系；不可见解不出现在结果里。 */
  issueRelationsBatch: (repoPath: string, numbers: string[]) =>
    invoke<Record<string, IssueRelations>>("issue_relations_batch", { repoPath, numbers }),
  /** 平台依赖写（G3-b）：让 blocked 依赖 blocker（FS）。两端须同仓库；
   *  Gitee 无端点（平台拒绝），容器形态走 projectDep*（G3-a）。 */
  issueDependencyAdd: (blockedRepo: string, blockedNumber: string, blockerRepo: string, blockerNumber: string) =>
    invoke<void>("issue_dependency_add", { blockedRepo, blockedNumber, blockerRepo, blockerNumber }),
  issueDependencyRemove: (blockedRepo: string, blockedNumber: string, blockerRepo: string, blockerNumber: string) =>
    invoke<void>("issue_dependency_remove", { blockedRepo, blockedNumber, blockerRepo, blockerNumber }),
  /** 平台父子写（G3-b 对称）：GitHub 原生 sub-issues；Gitea/Gitee 无（明确拒绝）。
   *  容器形态走 projectParent*（§3 结构扩展泳道）。 */
  issueParentSet: (childRepo: string, childNumber: string, parentRepo: string, parentNumber: string) =>
    invoke<void>("issue_parent_set", { childRepo, childNumber, parentRepo, parentNumber }),
  issueParentClear: (childRepo: string, childNumber: string, parentRepo: string, parentNumber: string) =>
    invoke<void>("issue_parent_clear", { childRepo, childNumber, parentRepo, parentNumber }),
  labelList: (repoPath: string) => invoke<LabelInfo[]>("label_list", { repoPath }),
  createLabel: (repoPath: string, name: string, color: string) =>
    invoke<LabelInfo>("create_label", { repoPath, name, color }),
  assigneeList: (repoPath: string) => invoke<string[]>("assignee_list", { repoPath }),
  setMilestoneState: (repoPath: string, number: number, closed: boolean) =>
    invoke<MilestoneInfo>("set_milestone_state", { repoPath, number, closed }),
  updateMilestone: (repoPath: string, number: number, title: string, description?: string, dueOn?: string) =>
    invoke<MilestoneInfo>("update_milestone", { repoPath, number, title, description: description ?? null, dueOn: dueOn ?? null }),

  // ---- 本地分支 review（PR 工作区本地形态）----
  branchReviewList: (repoPath: string, base: string) =>
    invoke<ReviewBranch[]>("branch_review_list", { repoPath, base }),
  branchReviewDiff: (repoPath: string, base: string, head: string) =>
    invoke<BranchReviewDiff>("branch_review_diff", { repoPath, base, head }),
  branchMerge: (repoPath: string, base: string, head: string, method: "merge" | "squash" | "rebase") =>
    invoke<string>("branch_merge", { repoPath, base, head, method }),
  branchDelete: (repoPath: string, name: string, force = false) =>
    invoke<void>("branch_delete", { repoPath, name, force }),
};
