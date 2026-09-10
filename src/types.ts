/** Mirrors src-tauri/src/models.rs */
export interface Issue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | string;
  body?: string | null;
  author?: string | null;
  milestone?: string | null;
  labels: string[];
  assignees: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
  url?: string | null;
}

export interface HealthInfo {
  ghAvailable: boolean;
  ghPath?: string | null;
  ghVersion?: string | null;
}

export interface RepoInfo {
  path: string;
  origin?: string | null;
}

export type IssueState = "open" | "closed" | "all";

export interface Pull {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  body?: string | null;
  author?: string | null;
  headRef?: string | null;
  baseRef?: string | null;
  labels: string[];
  assignees: string[];
  reviewers: string[];
  reviewDecision?: string | null;
  additions: number;
  deletions: number;
  commits: number;
  comments: number;
  isDraft: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  url?: string | null;
}

export type PullState = "open" | "closed" | "merged" | "all";
