/**
 * Per-repo sync timestamps, keyed "issues:<state>" / "pulls:<state>" —
 * one entry per filter bucket, because a Closed tab synced three days ago
 * and an Open tab synced five minutes ago are different facts. Rust stamps
 * the row on every successful refresh (migration 005's meta table); this
 * store mirrors it for the status bar and survives restarts with the cache.
 */
import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { api, isTauri } from "../api";
import { useRepoStore } from "./repo";

export const useSyncMetaStore = defineStore("sync-meta", () => {
  const map = ref<Record<string, string>>({});

  async function load() {
    const repo = useRepoStore();
    if (!repo.current || !isTauri()) return;
    try {
      map.value = Object.fromEntries(await api.listSyncedAt(repo.current));
    } catch {
      // Status-bar-only data; a failed read degrades to hidden cells.
      map.value = {};
    }
  }

  /** Client-side echo after a successful refresh (Rust is the authority;
   * the echo just saves a read roundtrip). */
  function stamp(key: string) {
    map.value = { ...map.value, [key]: new Date().toISOString() };
  }

  // Repo switches reload the whole map; selection lives elsewhere. The
  // immediate fire covers the startup path: the repo is usually restored
  // from localStorage and never changes afterwards.
  watch(
    () => useRepoStore().current,
    () => void load(),
    { immediate: true },
  );

  return { map, load, stamp };
});
