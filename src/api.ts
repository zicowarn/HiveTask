/**
 * Typed wrappers over the Rust command surface.
 *
 * `isTauri()` lets the same app run in a plain browser during quick UI
 * iteration — commands are unavailable there and guarded at call sites.
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  Comment,
  HealthInfo,
  Issue,
  IssueState,
  Pull,
  PullState,
  RepoInfo,
} from "./types";

export const isTauri = (): boolean => "__TAURI_INTERNALS__" in window;

export const api = {
  healthCheck: () => invoke<HealthInfo>("health_check"),
  pickRepo: () => invoke<string | null>("pick_repo"),
  repoInfo: (repoPath: string) =>
    invoke<RepoInfo>("repo_info", { repoPath }),
  refreshIssues: (repoPath: string, state: IssueState, limit = 50) =>
    invoke<Issue[]>("refresh_issues", { repoPath, state, limit }),
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
  listCachedComments: (repoPath: string, kind: "issue" | "pull", number: number) =>
    invoke<Comment[]>("list_cached_comments", { repoPath, kind, number }),
  fetchComments: (repoPath: string, kind: "issue" | "pull", number: number) =>
    invoke<Comment[]>("fetch_comments", { repoPath, kind, number }),
  // Returns the fresh conversation — the write-through contract.
  addComment: (repoPath: string, kind: "issue" | "pull", number: number, body: string) =>
    invoke<Comment[]>("add_comment", { repoPath, kind, number, body }),
  setIssueState: (repoPath: string, number: number, closed: boolean) =>
    invoke<Issue>("set_issue_state", { repoPath, number, closed }),
  setPullState: (repoPath: string, number: number, closed: boolean) =>
    invoke<Pull>("set_pull_state", { repoPath, number, closed }),
};
