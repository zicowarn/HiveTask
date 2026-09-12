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
const TERMINAL_SHELL_KEY = "hivetask.terminalShell";
const GITEA_HOST_KEY = "hivetask.giteaHost";

function loadStatusbarVisible(): boolean {
  try {
    return localStorage.getItem(STATUSBAR_KEY) !== "0";
  } catch {
    return true;
  }
}

function loadGiteaHost(): string {
  try {
    return localStorage.getItem(GITEA_HOST_KEY) ?? "";
  } catch {
    return "";
  }
}

function loadTerminalShell(): string {
  try {
    return localStorage.getItem(TERMINAL_SHELL_KEY) ?? "";
  } catch {
    return "";
  }
}

export const useSettingsStore = defineStore("settings", () => {
  const statusbarVisible = ref(loadStatusbarVisible());
  /** "" = auto ($SHELL / COMSPEC); else an explicit shell path/name. */
  const terminalShell = ref(loadTerminalShell());
  /** Gitea 实例地址（token 在 OS 钥匙串，见 credentials.rs）。 */
  const giteaHost = ref(loadGiteaHost());

  watch(statusbarVisible, (visible) => {
    try {
      localStorage.setItem(STATUSBAR_KEY, visible ? "1" : "0");
    } catch {
      // Storage unavailable — the choice still applies for this session.
    }
  });

  watch(terminalShell, (shell) => {
    try {
      localStorage.setItem(TERMINAL_SHELL_KEY, shell);
    } catch {
      // Storage unavailable — the choice still applies for this session.
    }
  });

  watch(giteaHost, (host) => {
    try {
      localStorage.setItem(GITEA_HOST_KEY, host);
    } catch {
      // Storage unavailable — the choice still applies for this session.
    }
  });

  function toggleStatusbar(): void {
    statusbarVisible.value = !statusbarVisible.value;
  }

  return { statusbarVisible, terminalShell, giteaHost, toggleStatusbar };
});
