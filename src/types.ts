/** Mirrors src-tauri/src/models.rs */
export interface GitCommitRow {
  oid: string;
  parents: string[];
  message: string;
  author?: string | null;
  committedAtUnix: number;
}

export interface GitRefRow {
  name: string;
  target: string;
  kind: "head" | "remote" | "current" | string;
}

export interface GitHistoryPage {
  commits: GitCommitRow[];
  refs: GitRefRow[];
  head: string | null;
  hasMore: boolean;
}

export interface GitBranchRow {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  shortId?: string | null;
  ahead: number;
  behind: number;
}
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
  /** Path exists on disk — false means the persisted repo rotted away. */
  valid?: boolean;
  /** 来源路由口径（登记连接 > host 推断）；null = 本地/未知。 */
  platform?: string | null;
}

export type IssueState = "open" | "closed" | "all";

/** One conversation comment; `pending` marks the optimistic pre-ack row. */
export interface Comment {
  author?: string | null;
  body?: string | null;
  createdAt?: string | null;
  pending?: boolean;
}

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
