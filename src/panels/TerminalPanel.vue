<script setup lang="ts">
/**
 * Integrated terminal — xterm.js over a portable-pty session (per-OS shell
 * selectable in settings; defaults to $SHELL / COMSPEC). One PTY per panel
 * instance, keyed by leafId; killed on unmount and respawned fresh.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Channel } from "@tauri-apps/api/core";
import PanelShell from "../workbench/PanelShell.vue";
import { api, isTauri } from "../api";
import { useRepoStore } from "../stores/repo";
import { useSettingsStore } from "../stores/settings";
import { useI18n } from "../i18n";
import { useTheme, type ResolvedTheme } from "../theme";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{ leafId?: string; panelType?: string }>();

const repo = useRepoStore();
const settings = useSettingsStore();
const { current } = storeToRefs(repo);
const { t } = useI18n();
const { resolvedTheme } = useTheme();

const holder = ref<HTMLElement | null>(null);
const exited = ref(false);

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let observer: ResizeObserver | null = null;
const sessionId = props.leafId ?? `pty-${Math.random().toString(36).slice(2)}`;

const THEMES: Record<ResolvedTheme, { background: string; foreground: string; cursor: string; selectionBackground: string }> = {
  dark: { background: "#1e1f22", foreground: "#dfe1e5", cursor: "#5b8def", selectionBackground: "#2e436e" },
  light: { background: "#ffffff", foreground: "#1f2328", cursor: "#0969da", selectionBackground: "#dce7fd" },
};

const EXIT_MARKER = "\u{1b}[__HIVETASK_PTY_EXIT__]";

async function spawn() {
  if (!isTauri() || !term || !fit) return;
  exited.value = false;
  term.reset();
  fit.fit();
  const onOutput = new Channel<string>();
  onOutput.onmessage = (data) => {
    if (data === EXIT_MARKER) {
      exited.value = true;
      term?.writeln(t("terminal.exited"));
      return;
    }
    term?.write(data);
  };
  try {
    await api.ptySpawn({
      id: sessionId,
      cwd: current.value ?? undefined,
      shell: settings.terminalShell || undefined,
      rows: term.rows,
      cols: term.cols,
      onOutput,
    });
  } catch (e) {
    exited.value = true;
    term.writeln(`[!] ${String(e)}`);
  }
}

onMounted(() => {
  if (!holder.value) return;
  term = new Terminal({
    fontSize: 12,
    cursorBlink: true,
    theme: THEMES[resolvedTheme.value],
    scrollback: 5000,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(holder.value);
  fit.fit();
  term.onData((data) => {
    if (!exited.value) void api.ptyWrite(sessionId, data);
  });
  term.onResize(({ rows, cols }) => {
    if (!exited.value) void api.ptyResize(sessionId, rows, cols);
  });
  observer = new ResizeObserver(() => fit?.fit());
  observer.observe(holder.value);
  void spawn();
});

// A repo switch re-cwd's the session only on next spawn; the shell keeps
// running otherwise (like a real terminal).

onBeforeUnmount(() => {
  observer?.disconnect();
  if (isTauri()) void api.ptyKill(sessionId).catch(() => {});
  term?.dispose();
  term = null;
});

// Restart affordance after the shell exits.
function restart() {
  void spawn();
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <div class="terminal-wrap">
      <div v-if="!isTauri()" class="terminal-note">{{ t("error.browserPreview") }}</div>
      <template v-else>
        <div ref="holder" class="xterm-holder"></div>
        <button v-if="exited" class="restart-btn" @click="restart">
          {{ t("terminal.restart") }}
        </button>
      </template>
    </div>
  </PanelShell>
</template>

<style scoped>
.terminal-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  background: var(--bg-app);
}
.terminal-note {
  margin: auto;
  color: var(--text-dim);
  font-size: var(--font-md);
}
.xterm-holder {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
}
.restart-btn {
  position: absolute;
  right: 12px;
  bottom: 12px;
  border: 1px solid var(--accent);
  background: var(--bg-selected);
  color: var(--accent);
  font-size: var(--font-md);
  height: 24px;
  padding: 0 14px;
  border-radius: 6px;
  cursor: pointer;
}
</style>
