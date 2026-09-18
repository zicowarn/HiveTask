<script setup lang="ts">
/**
 * Settings "basic" mode — the counterpart of QHiveFrame's General
 * preference panel: language, theme, source connections, terminal shell
 * and the status bar toggle. Controls write straight through to their
 * owning modules (i18n / theme / settings store); there is no separate
 * save step. 来源连接管理在独立对话框（SourceConnectionsDialog）。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useI18n, type LocaleChoice } from "../../i18n";
import { useTheme, type ThemeChoice } from "../../theme";
import { useSettingsStore } from "../../stores/settings";
import SourceConnectionsDialog from "../../components/SourceConnectionsDialog.vue";
import GitHubAuthDialog from "../../components/GitHubAuthDialog.vue";
import CalendarFeedsDialog from "../CalendarFeedsDialog.vue";
import DropdownMenu from "../../components/DropdownMenu.vue";
import { api, isTauri } from "../../api";
import { useKnowledgeStore } from "../../stores/knowledge";
import EditorIcon from "../../components/EditorIcon.vue";

const { t, localeChoice, setLocale } = useI18n();
const { theme, setTheme } = useTheme();
const settings = useSettingsStore();

const connectionsOpen = ref(false);
const feedsOpen = ref(false);

// ---- 打开方式（知识库「默认应用打开」用哪个应用；存 app.db，由 Rust 读）----
const knowledge = useKnowledgeStore();
const openAppDraft = ref("");
const openAppSaving = ref(false);
onMounted(() => {
  void knowledge.loadOpenWith();
});
watch(
  () => knowledge.openWith,
  (prefs) => {
    openAppDraft.value = prefs.defaultApp;
  },
  { immediate: true, deep: true },
);
/** 失焦/回车提交：空串 = 系统默认程序。 */
async function commitOpenApp(): Promise<void> {
  const value = openAppDraft.value.trim();
  if (value === knowledge.openWith.defaultApp) return;
  openAppSaving.value = true;
  try {
    await knowledge.saveOpenWith({ ...knowledge.openWith, defaultApp: value });
  } finally {
    openAppSaving.value = false;
  }
}
/** 按扩展名覆盖：`{ ".md": "Typora", ".dwg": "AutoCAD" }` 的 UI 行。 */
interface ByExtRow {
  ext: string;
  app: string;
}
const byExtRows = ref<ByExtRow[]>([]);
watch(
  () => knowledge.openWith.byExt,
  (byExt) => {
    byExtRows.value = Object.entries(byExt ?? {}).map(([ext, app]) => ({ ext, app }));
  },
  { immediate: true, deep: true },
);

async function saveByExt(rows: ByExtRow[]): Promise<void> {
  const byExt: Record<string, string> = {};
  for (const row of rows) {
    const ext = row.ext.trim().toLowerCase();
    const app = row.app.trim();
    if (ext && app) byExt[ext.startsWith(".") ? ext : `.${ext}`] = app;
  }
  await knowledge.saveOpenWith({ ...knowledge.openWith, byExt });
}

function addByExtRow(): void {
  byExtRows.value = [...byExtRows.value, { ext: "", app: "" }];
}

async function removeByExtRow(index: number): Promise<void> {
  byExtRows.value = byExtRows.value.filter((_, i) => i !== index);
  await saveByExt(byExtRows.value);
}

async function commitByExtRow(index: number): Promise<void> {
  const row = byExtRows.value[index];
  if (!row) return;
  // 两栏都有内容才写入；空行跳过
  if (!row.ext.trim() || !row.app.trim()) return;
  await saveByExt(byExtRows.value);
}

/** 原生选择器挑应用（macOS 选 .app / Windows 选 .exe / Linux 选可执行文件）。 */
async function pickOpenApp(): Promise<void> {
  if (!isTauri()) return;
  const picked = await api.kbPickApp();
  if (!picked) return;
  openAppDraft.value = picked;
  await commitOpenApp();
}

// ---- GitHub 账户（Device Flow 登录；凭据归 gh 托管）----
const ghLogin = ref<string | null>(null);
const ghAuthOpen = ref(false);
const ghLoginResolved = ref(false);
const ghLoginLabel = computed(() => {
  if (ghLoginResolved.value && ghLogin.value) return ghLogin.value;
  if (ghLoginResolved.value) return t("githubAuth.notLoggedIn");
  return t("list.loading");
});
async function refreshGhLogin() {
  if (!isTauri()) return;
  try {
    ghLogin.value = await api.ghAuthUser();
  } catch {
    ghLogin.value = null;
  } finally {
    ghLoginResolved.value = true;
  }
}
function onAuthSuccess(login: string) {
  ghLogin.value = login;
}
onMounted(() => {
  void refreshGhLogin();
});

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

function onLocaleChange(value: string | string[]) {
  setLocale(value as LocaleChoice);
}
function onThemeChange(value: string | string[]) {
  setTheme(value as ThemeChoice);
}
</script>

<template>
  <div class="settings-basic">
    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.language") }}</span>
        <span class="setting-desc">{{ t("settings.languageDesc") }}</span>
      </div>
      <DropdownMenu
        class="setting-dd"
        :options="[...languageChoices, { value: 'system', label: t('lang.system') }]"
        :model-value="localeChoice"
        @update:model-value="onLocaleChange"
      />
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.theme") }}</span>
        <span class="setting-desc">{{ t("settings.themeDesc") }}</span>
      </div>
      <DropdownMenu
        class="setting-dd"
        :options="themeChoices.map((c) => ({ value: c.value, label: t(c.labelKey) }))"
        :model-value="theme"
        @update:model-value="onThemeChange"
      />
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.connections") }}</span>
        <span class="setting-desc">{{ t("settings.connectionsDesc") }}</span>
      </div>
      <button class="setting-btn" @click="connectionsOpen = true">
        {{ t("settings.connectionsManage") }}
      </button>
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("githubAuth.row") }}</span>
        <span class="setting-desc">{{ ghLoginLabel }}</span>
      </div>
      <button class="setting-btn" @click="((ghAuthOpen = true))">
        {{ t("githubAuth.loginBtn") }}
      </button>
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.calendarFeeds") }}</span>
        <span class="setting-desc">{{ t("settings.calendarFeedsDesc") }}</span>
      </div>
      <button class="setting-btn" @click="feedsOpen = true">
        {{ t("settings.calendarFeedsManage") }}
      </button>
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.terminalShell") }}</span>
        <span class="setting-desc">{{ t("settings.terminalShellDesc") }}</span>
      </div>
      <DropdownMenu class="setting-dd" :options="shellChoices" v-model="settings.terminalShell" />
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.openWith") }}</span>
        <span class="setting-desc">{{ t("settings.openWithDesc") }}</span>
      </div>
      <div class="setting-open-with">
        <input
          v-model="openAppDraft"
          class="setting-input"
          :placeholder="t('settings.openWithPlaceholder')"
          spellcheck="false"
          @keydown.enter="commitOpenApp"
          @blur="commitOpenApp"
        />
        <button class="setting-btn" :disabled="openAppSaving || !isTauri()" @click="pickOpenApp">
          <EditorIcon name="o.file-directory" />
          {{ t("settings.openWithPick") }}
        </button>
      </div>
    </div>

    <!-- 按扩展名覆盖：不在默认应用行里塞（会挤），单独一个子区块 -->
    <div class="setting-byext">
      <div class="byext-head">
        <span class="setting-name">{{ t("settings.byExtTitle") }}</span>
        <button class="text-btn" @click="addByExtRow">{{ t("settings.byExtAdd") }}</button>
      </div>
      <p class="byext-desc">{{ t("settings.byExtDesc") }}</p>
      <div v-for="(row, index) in byExtRows" :key="index" class="byext-row">
        <input
          v-model="row.ext"
          class="setting-input byext-ext"
          :placeholder="t('settings.byExtExtPlaceholder')"
          spellcheck="false"
          @keydown.enter="commitByExtRow(index)"
          @blur="commitByExtRow(index)"
        />
        <span class="byext-arrow">→</span>
        <input
          v-model="row.app"
          class="setting-input byext-app"
          :placeholder="t('settings.byExtAppPlaceholder')"
          spellcheck="false"
          @keydown.enter="commitByExtRow(index)"
          @blur="commitByExtRow(index)"
        />
        <button class="byext-remove" :title="t('settings.byExtRemove')" @click="removeByExtRow(index)">
          <EditorIcon name="o.x" />
        </button>
      </div>
      <p v-if="!byExtRows.length" class="byext-empty">{{ t("settings.byExtEmpty") }}</p>
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

    <CalendarFeedsDialog v-if="feedsOpen" @close="feedsOpen = false" />
    <SourceConnectionsDialog
      :open="connectionsOpen"
      @close="connectionsOpen = false"
    />

    <GitHubAuthDialog :open="ghAuthOpen" @close="((ghAuthOpen = false), refreshGhLogin())" @success="onAuthSuccess" />
  </div>
</template>

<style scoped>
.settings-basic {
  flex: 1;
  overflow-y: auto;
  padding: 10px 20px;
  /* 用户口径：内容居中、满屏时最宽 60%（min 保证窄窗口不至于挤到不可用） */
  max-width: max(480px, 60%);
  margin: 0 auto;
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
  font-size: var(--font-base);
  color: var(--text);
}
.setting-desc {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 设置行的统一下拉（DropdownMenu 组件），宽度对齐原生 select 时代 */
.setting-dd {
  width: 110px;
}
.setting-btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  height: 24px;
  padding: 0 12px;
  border-radius: 5px;
  cursor: pointer;
}
.setting-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.setting-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
/* 按扩展名覆盖：子区块，比普通 setting-row 多一层缩进 */
.setting-byext {
  padding: 10px 0 14px 16px;
  border-bottom: 1px solid var(--border);
}
.byext-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.byext-desc {
  margin: 0 0 8px;
  font-size: var(--font-sm);
  color: var(--text-dim);
  line-height: 1.5;
}
.byext-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 0;
}
.byext-arrow {
  flex: none;
  color: var(--text-dim);
  font-size: var(--font-sm);
}
.byext-ext {
  width: 90px;
  flex: none;
}
.byext-app {
  flex: 1 1 auto;
  min-width: 0;
}
.byext-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.byext-remove:hover {
  background: var(--bg-hover);
  color: var(--danger, #e5534b);
}
.byext-empty {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 「打开方式」：应用名输入 + 原生选择器并排（宽度上限，免得太长挤掉说明文字） */
.setting-open-with {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.setting-input {
  width: 190px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  outline: none;
}
.setting-input:focus {
  border-color: var(--accent);
}
.setting-check {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
  cursor: pointer;
}
</style>
