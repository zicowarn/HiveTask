<script setup lang="ts">
/**
 * Settings "basic" mode — the counterpart of QHiveFrame's General
 * preference panel: language and theme, plus the status bar toggle.
 * Controls write straight through to their owning modules (i18n / theme /
 * settings store); there is no separate save step.
 */
import { useI18n, type LocaleChoice } from "../../i18n";
import { useTheme, type ThemeChoice } from "../../theme";
import { useSettingsStore } from "../../stores/settings";

const { t, localeChoice, setLocale } = useI18n();
const { theme, setTheme } = useTheme();
const settings = useSettingsStore();

const themeChoices: { value: ThemeChoice; labelKey: "settings.themeDark" | "settings.themeLight" | "settings.themeSystem" }[] = [
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "light", labelKey: "settings.themeLight" },
  { value: "system", labelKey: "settings.themeSystem" },
];

/** Terminal shell options per OS; "" = auto ($SHELL / COMSPEC). */
const isWindows = navigator.userAgent.includes("Windows");
const shellChoices: { value: string; label: string }[] = isWindows
  ? [
      { value: "", label: t("settings.shellAuto") },
      { value: "cmd.exe", label: "cmd" },
      { value: "powershell.exe", label: "PowerShell" },
      { value: "pwsh.exe", label: "pwsh" },
    ]
  : [
      { value: "", label: t("settings.shellAuto") },
      { value: "/bin/zsh", label: "zsh" },
      { value: "/bin/bash", label: "bash" },
    ];

const languageChoices: { value: "zh-CN" | "en-US"; label: string }[] = [
  { value: "zh-CN", label: "中文" },
  { value: "en-US", label: "English" },
];

function onLocaleChange(event: Event) {
  setLocale((event.target as HTMLSelectElement).value as LocaleChoice);
}
function onThemeChange(event: Event) {
  setTheme((event.target as HTMLSelectElement).value as ThemeChoice);
}
</script>

<template>
  <div class="settings-basic">
    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.language") }}</span>
        <span class="setting-desc">{{ t("settings.languageDesc") }}</span>
      </div>
      <select class="setting-select" :value="localeChoice" @change="onLocaleChange">
        <option v-for="l in languageChoices" :key="l.value" :value="l.value">{{ l.label }}</option>
        <option value="system">{{ t("lang.system") }}</option>
      </select>
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.theme") }}</span>
        <span class="setting-desc">{{ t("settings.themeDesc") }}</span>
      </div>
      <select class="setting-select" :value="theme" @change="onThemeChange">
        <option v-for="c in themeChoices" :key="c.value" :value="c.value">
          {{ t(c.labelKey) }}
        </option>
      </select>
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.terminalShell") }}</span>
        <span class="setting-desc">{{ t("settings.terminalShellDesc") }}</span>
      </div>
      <select class="setting-select" v-model="settings.terminalShell">
        <option v-for="c in shellChoices" :key="c.value" :value="c.value">{{ c.label }}</option>
      </select>
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.statusbar") }}</span>
        <span class="setting-desc">{{ t("settings.statusbarDesc") }}</span>
      </div>
      <input
        v-model="settings.statusbarVisible"
        class="setting-check"
        type="checkbox"
      />
    </div>
  </div>
</template>

<style scoped>
.settings-basic {
  flex: 1;
  overflow-y: auto;
  padding: 10px 20px;
  max-width: 640px;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
.setting-row:last-child {
  border-bottom: none;
}
.setting-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.setting-name {
  font-size: 13px;
  color: var(--text);
}
.setting-desc {
  font-size: 11px;
  color: var(--text-dim);
}
.setting-select {
  appearance: none;
  -webkit-appearance: none;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background-color: var(--bg-app);
  color: var(--text);
  font-size: 12px;
  padding: 0 22px 0 8px;
  cursor: pointer;
  outline: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' fill='none' stroke='%239aa0a8' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 6px center;
  background-size: 8px;
}
.setting-select:hover,
.setting-select:focus-visible {
  border-color: var(--accent);
}
/* Same chevron swap as PanelShell: the data URI can't read CSS vars. */
[data-theme="light"] .setting-select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' fill='none' stroke='%23656d76' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
.setting-check {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
  cursor: pointer;
}
</style>
