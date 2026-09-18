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
// 设计：**不再让用户手打应用名** —— 应用清单与"系统认为谁能开这个后缀"都来自系统
// （Rust `kb_apps_list` / `kb_apps_for_ext`，后者就是 Finder「打开方式」那张表）。
const knowledge = useKnowledgeStore();
onMounted(() => {
  void knowledge.loadOpenWith();
  void knowledge.loadSystemApps();
});

/** 按扩展名覆盖：`{ ".md": "/Applications/Typora.app" }` 的 UI 行。 */
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

/** 扩展名归一（与后端 `normalize_ext` 同一口径）。 */
function cleanExt(ext: string): string {
  return ext.trim().replace(/^\./, "").toLowerCase();
}

/**
 * 每个扩展名的系统登记结果（懒加载 + 缓存）：菜单打开、或扩展名提交时才去问一次。
 * 缓存空结果也算"问过了" —— 否则每次开菜单都白跑一趟 LaunchServices。
 */
const extApps = ref<Record<string, ExtApps>>({});
const extLoading = ref<Record<string, boolean>>({});

async function ensureExtApps(ext: string): Promise<void> {
  const key = cleanExt(ext);
  if (!key || key in extApps.value || extLoading.value[key]) return;
  extLoading.value = { ...extLoading.value, [key]: true };
  try {
    const result = await knowledge.appsForExt(key);
    extApps.value = { ...extApps.value, [key]: result };
  } finally {
    const next = { ...extLoading.value };
    delete next[key];
    extLoading.value = next;
  }
}

/** 应用名：路径取 bundle 名（`/Applications/Typora.app` → `Typora`），旧的手填名原样。 */
function appLabel(value: string): string {
  const base = value.split("/").pop() ?? value;
  return base.endsWith(".app") ? base.slice(0, -4) : base;
}

/** 选择器条目：系统登记（默认 + 候选）在上，全部已装应用在下；当前值不在其中时补一条。 */
function appSections(row: ByExtRow): DropdownSection[] {
  const key = cleanExt(row.ext);
  const cached = key ? extApps.value[key] : undefined;
  const sections: DropdownSection[] = [];
  const seen = new Set<string>();

  if (cached?.default) {
    sections.push({
      title: t("settings.byExtSystemDefault"),
      options: [{ value: cached.default.path, label: cached.default.name }],
    });
    seen.add(cached.default.path);
  }
  const registered = (cached?.candidates ?? []).filter((app) => !seen.has(app.path));
  if (registered.length) {
    sections.push({
      title: t("settings.byExtSystemGroup"),
      options: registered.map((app) => ({ value: app.path, label: app.name })),
    });
    for (const app of registered) seen.add(app.path);
  }

  const rest = knowledge.systemApps.filter((app) => !seen.has(app.path));
  if (rest.length) {
    sections.push({
      title: t("settings.byExtAllGroup"),
      options: rest.map((app) => ({ value: app.path, label: app.name })),
    });
  }

  // 当前值（旧配置手填的名称 / 已卸载的应用）不在上面任何一组里：补一条，
  // 否则触发器会显示成空 —— 用户就看不见自己配了什么
  if (row.app && !seen.has(row.app) && !rest.some((app) => app.path === row.app)) {
    sections.unshift({
      title: t("settings.byExtCurrentGroup"),
      options: [{ value: row.app, label: appLabel(row.app) }],
    });
  }
  return sections;
}

async function saveByExt(rows: ByExtRow[]): Promise<void> {
  const byExt: Record<string, string> = {};
  for (const row of rows) {
    const ext = cleanExt(row.ext);
    const app = row.app.trim();
    if (ext && app) byExt[ext.startsWith(".") ? ext : `.${ext}`] = app;
  }
  await knowledge.saveOpenWith({ byExt });
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
  // 扩展名先落定，再去问系统"谁能开它"（选择器下次打开就有系统建议了）
  void ensureExtApps(row.ext);
  // 两栏都有内容才写入；空行跳过
  if (!cleanExt(row.ext) || !row.app.trim()) return;
  await saveByExt(byExtRows.value);
}

/** 选中某个应用（值 = `.app` 绝对路径，或旧配置里的应用名）。 */
async function pickRowApp(index: number, value: string): Promise<void> {
  const row = byExtRows.value[index];
  if (!row || !value) return;
  row.app = value;
  // 数组里的对象是响应式的（byExtRows 在 ref 里），改完成即写盘
  await saveByExt(byExtRows.value.map((r, i) => (i === index ? { ...r, app: value } : r)));
}

/** 菜单打开时才去问系统（懒加载：不在扩展名输入框上每敲一个字都查一次）。 */
function onRowMenuOpen(index: number, isOpenNow: boolean): void {
  if (!isOpenNow) return;
  const row = byExtRows.value[index];
  if (row) void ensureExtApps(row.ext);
}

/** 「浏览…」：原生选择器挑应用（macOS 选 .app / Windows 选 .exe / Linux 选可执行文件）。 */
async function browseRowApp(index: number): Promise<void> {
  if (!isTauri()) return;
  const picked = await api.kbPickApp();
  if (picked) await pickRowApp(index, picked);
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

    <!-- 打开方式：不再让用户手打应用名（右侧输入框与按钮按用户要求移除）——
         应用的选择在下面「按扩展名指定」里用系统应用选择器完成 -->
    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.openWith") }}</span>
        <span class="setting-desc">{{ t("settings.openWithDesc") }}</span>
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
        <DropdownMenu
          class="byext-app"
          filterable
          :sections="appSections(row)"
          :model-value="row.app"
          :placeholder="t('settings.byExtAppPick')"
          :action="{ value: 'browse', label: t('settings.openWithPick'), icon: 'o.file-directory' }"
          @update:model-value="(value) => pickRowApp(index, String(value))"
          @action="browseRowApp(index)"
          @open-change="(open) => onRowMenuOpen(index, open)"
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
