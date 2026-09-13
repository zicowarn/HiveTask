import { defineStore } from "pinia";
import { ref } from "vue";
import { pushToast } from "../toast";
import { t } from "../i18n";
import { api, isTauri } from "../api";
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
  // 当前仓库的来源路由口径（repo_info 与运行时同链解析）；null = 本地/未知。
  const platform = ref<string | null>(null);

  // Startup guard: a persisted path may have rotted away (e.g. /tmp cleanup).
  // Clear it so the UI falls back to "未选择仓库" instead of dead reads.
  void (async () => {
    if (!current.value || !isTauri()) return;
    // 仅远端登记的 current 是 URL，不是磁盘路径，is_dir 必然 false——
    // 不做失效检查（交给使用时的 resolve_target），只取来源口径。
    if (/^https?:\/\//i.test(current.value)) {
      try {
        platform.value = (await api.repoInfo(current.value)).platform ?? null;
      } catch {
        // best-effort
      }
      return;
    }
    try {
      const info = await api.repoInfo(current.value);
      platform.value = info.platform ?? null;
      if (info.valid === false) {
        current.value = null;
        platform.value = null;
        localStorage.removeItem(LAST_KEY);
      }
    } catch {
      // Probe is best-effort; keep the persisted path on failure.
    }
  })();
  const recent = ref<string[]>(loadRecent());
  // null = not checked yet (e.g. plain-browser preview skips the probe).
  const ghAvailable = ref<boolean | null>(null);

  async function checkHealth() {
    if (!isTauri()) return;
    try {
      const health = await api.healthCheck();
      ghAvailable.value = health.ghAvailable;
    } catch {
      ghAvailable.value = false;
    }
  }

  function setCurrent(path: string) {
    current.value = path;
    localStorage.setItem(LAST_KEY, path);
    recent.value = [path, ...recent.value.filter((p) => p !== path)].slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value));
    refreshInfo();
  }

  async function pick() {
    if (!isTauri()) {
      pushToast({ kind: "info", message: t("error.browserPreview") });
      return;
    }
    const path = await api.pickRepo();
    if (path) setCurrent(path);
  }

  async function refreshInfo() {
    if (!current.value) {
      origin.value = null;
      platform.value = null;
      return;
    }
    try {
      const info: RepoInfo = await api.repoInfo(current.value);
      origin.value = info.origin ?? null;
      platform.value = info.platform ?? null;
    } catch {
      origin.value = null;
      platform.value = null;
    }
  }

  return { current, origin, platform, recent, ghAvailable, checkHealth, setCurrent, pick, refreshInfo };
});
