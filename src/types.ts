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
