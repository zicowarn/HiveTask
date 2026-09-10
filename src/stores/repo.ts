import { defineStore } from "pinia";
import { ref } from "vue";
import { api } from "../api";
import type { RepoInfo } from "../types";

const RECENT_KEY = "hivetask.recentRepos";
const LAST_KEY = "hivetask.lastRepo";

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

/**
 * Repository context: gh resolves owner/repo from the folder's git remotes.
 * Persisted to localStorage; can move to tauri-plugin-store when settings
 * grow (migrations, multiple data sources).
 */
export const useRepoStore = defineStore("repo", () => {
  const current = ref<string | null>(localStorage.getItem(LAST_KEY));
  const origin = ref<string | null>(null);
  const recent = ref<string[]>(loadRecent());

  function setCurrent(path: string) {
    current.value = path;
    localStorage.setItem(LAST_KEY, path);
    recent.value = [path, ...recent.value.filter((p) => p !== path)].slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value));
    refreshInfo();
  }

  async function pick() {
    const path = await api.pickRepo();
    if (path) setCurrent(path);
  }

  async function refreshInfo() {
    if (!current.value) {
      origin.value = null;
      return;
    }
    try {
      const info: RepoInfo = await api.repoInfo(current.value);
      origin.value = info.origin ?? null;
    } catch {
      origin.value = null;
    }
  }

  return { current, origin, recent, setCurrent, pick, refreshInfo };
});
