/**
 * Typed wrappers over the Rust command surface.
 *
 * `isTauri()` lets the same app run in a plain browser during quick UI
 * iteration — commands are unavailable there and guarded at call sites.
 */
import { invoke } from "@tauri-apps/api/core";
import type { HealthInfo, Issue, IssueState, RepoInfo } from "./types";

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
};
