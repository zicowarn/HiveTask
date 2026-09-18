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
  number: string | null;
  draftTitle: string | null;
  draftBody: string | null;
  rank: string;
  addedAt: string;
  repoLabel: string | null;
  ghost: boolean;
  fieldValues: Record<string, string>;
  /** 引用实体的镜像元数据（仓库缓存里的 Issue/PR 行）；草稿/悬挂/未同步为 null。 */
  entity?: ProjectEntityMeta | null;
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
  /** 空 = 系统默认程序。 */
  defaultApp: string;
  /** 扩展名（小写、不含点）→ 应用名 / 可执行文件路径。 */
  byExt: Record<string, string>;
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
  /** 写入二进制（粘贴/拖放插图）：base64 传参，父目录自动创建。 */
  kbWriteBytes: (root: string, rel: string, base64: string) =>
    invoke<KbEntry>("kb_write_bytes", { root, rel, base64 }),
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
