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
  GitHistoryPage,
  HealthInfo,
  Issue,
  IssueState,
  Pull,
  PullState,
  RepoInfo,
} from "./types";

// ---- Projects 看板（应用级，P4）----

export interface FieldOption {
  id: string;
  name: string;
  color: string;
}

export interface Project {
  id: string;
  displayName: string;
  description: string | null;
  groupTag: string | null;
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

export const isTauri = (): boolean => "__TAURI_INTERNALS__" in window;

export const api = {
  healthCheck: () => invoke<HealthInfo>("health_check"),
  pickRepo: () => invoke<string | null>("pick_repo"),
  repoInfo: (repoPath: string) =>
    invoke<RepoInfo>("repo_info", { repoPath }),
  refreshIssues: (repoPath: string, state: IssueState, limit = 50) =>
    invoke<Issue[]>("refresh_issues", { repoPath, state, limit }),
  // v1 仅本地仓库（journal + SQLite）；远端创建后续接同一命令。
  createIssue: (repoPath: string, title: string, body?: string) =>
    invoke<Issue>("create_issue", { repoPath, title, body: body ?? null }),
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
  setIssueState: (repoPath: string, number: string, closed: boolean) =>
    invoke<Issue>("set_issue_state", { repoPath, number, closed }),
  setPullState: (repoPath: string, number: number, closed: boolean) =>
    invoke<Pull>("set_pull_state", { repoPath, number, closed }),
  mergePull: (repoPath: string, number: number, method: "merge" | "squash" | "rebase") =>
    invoke<Pull>("merge_pull", { repoPath, number, method }),
  gitHistory: (repoPath: string, limit?: number) =>
    invoke<GitHistoryPage>("git_history", { repoPath, limit: limit ?? 500 }),
  gitBranches: (repoPath: string) => invoke<GitBranchRow[]>("git_branches", { repoPath }),
  gitFetch: (repoPath: string) => invoke<void>("git_fetch", { repoPath }),
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
  projectCreate: (name: string, description?: string) =>
    invoke<Project>("project_create", { name, description: description ?? null }),
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
  projectItemMove: (itemId: string, statusOptionId?: string, prevId?: string, nextId?: string) =>
    invoke<ProjectItem>("project_item_move", {
      itemId,
      statusOptionId: statusOptionId ?? null,
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
  remoteRepoList: (platform: string, host: string) =>
    invoke<RemoteRepoInfo[]>("remote_repo_list", { platform, host }),
};
