/**
 * Cross-cutting UI preferences that are neither locale (src/i18n) nor theme
 * (src/theme.ts): currently just the status bar's visibility. Those two
 * modules stay standalone refs so components can use them without Pinia;
 * everything that only chrome needs (and that menus/settings toggle) lands
 * here.
 */
import { defineStore } from "pinia";
import { ref, watch } from "vue";

const STATUSBAR_KEY = "hivetask.statusbar";

function loadStatusbarVisible(): boolean {
  try {
    return localStorage.getItem(STATUSBAR_KEY) !== "0";
  } catch {
    return true;
  }
}

export const useSettingsStore = defineStore("settings", () => {
  const statusbarVisible = ref(loadStatusbarVisible());

  watch(statusbarVisible, (visible) => {
    try {
      localStorage.setItem(STATUSBAR_KEY, visible ? "1" : "0");
    } catch {
      // Storage unavailable — the choice still applies for this session.
    }
  });

  function toggleStatusbar(): void {
    statusbarVisible.value = !statusbarVisible.value;
  }

  return { statusbarVisible, toggleStatusbar };
});
