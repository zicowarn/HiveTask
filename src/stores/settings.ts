/**
 * Cross-cutting UI preferences that are neither locale (src/i18n) nor theme
 * (src/theme.ts): currently just the status bar's visibility. Those two
 * modules stay standalone refs so components can use them without Pinia;
 * everything that only chrome needs (and that menus/settings toggle) lands
 * here.
 */
import { defineStore } from "pinia";
import { api, isTauri } from "../api";
import { ref, watch } from "vue";

const STATUSBAR_KEY = "hivetask.statusbar";
const TERMINAL_SHELL_KEY = "hivetask.terminalShell";


function loadStatusbarVisible(): boolean {
  try {
    return localStorage.getItem(STATUSBAR_KEY) !== "0";
  } catch {
    return true;
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
  /** Gitea 实例地址（token 在 OS 钥匙串）。存 Rust 侧 source.json——
   * source_for 在命令内同步读取，webview localStorage 它看不见。 */
  const giteaHost = ref("");

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

  // 首次从 Rust 配置加载；此后本地镜像，变化即回写（防抖由调用方天然稀疏）。
  void (async () => {
    if (!isTauri()) return;
    try {
      const config = await api.sourceConfigGet();
      giteaHost.value = config.giteaHost ?? "";
    } catch {
      // 设置读取失败不阻塞 UI，保持空值。
    }
  })();

  let giteaSaveTimer: ReturnType<typeof setTimeout> | null = null;
  watch(giteaHost, (host) => {
    if (giteaSaveTimer) clearTimeout(giteaSaveTimer);
    giteaSaveTimer = setTimeout(() => {
      void api.sourceConfigSet({ giteaHost: host || null }).catch(() => {});
    }, 400);
  });

  function toggleStatusbar(): void {
    statusbarVisible.value = !statusbarVisible.value;
  }

  return { statusbarVisible, terminalShell, giteaHost, toggleStatusbar };
});
