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
import ImportPackDialog from "../../components/ImportPackDialog.vue";
import DropdownMenu, { type DropdownSection } from "../../components/DropdownMenu.vue";
import { api, isTauri, type BackupStatus, type CalendarFeed, type ExtApps } from "../../api";
import { SYNC_INTERVAL_CHOICES } from "../../sync-scheduler";
import { useKnowledgeStore } from "../../stores/knowledge";
import { useProjectsStore } from "../../stores/projects";
import EditorIcon from "../../components/EditorIcon.vue";
import { pushToast } from "../../toast";
import { reportError } from "../../gh-errors";

const { t, localeChoice, setLocale } = useI18n();
const { theme, setTheme } = useTheme();
const settings = useSettingsStore();
const projects = useProjectsStore();

const connectionsOpen = ref(false);

// ---- 日历订阅：内联子区块（「按扩展名指定」同款形态，无对话框）----
const feeds = ref<CalendarFeed[]>([]);
const feedDraft = ref<{ name: string; url: string } | null>(null);
const feedWorking = ref(false);
const feedError = ref<string | null>(null);
const feedSyncingId = ref<string | null>(null);
/** 两击确认删除。 */
const feedArmedId = ref<string | null>(null);
const DEFAULT_FEED_COLOR = "#5b8def";

async function loadFeeds(): Promise<void> {
  if (!isTauri()) return;
  try {
    feeds.value = await api.calendarFeedList();
  } catch (e) {
    feedError.value = String(e);
  }
}
function addFeedDraft(): void {
  feedDraft.value = { name: "", url: "" };
}
async function commitFeedDraft(): Promise<void> {
  const d = feedDraft.value;
  if (!d || feedWorking.value) return;
  if (!d.name.trim() || !d.url.trim()) return; // 未填完不提交（byext 同款静默）
  feedWorking.value = true;
  feedError.value = null;
  try {
    await api.calendarFeedAdd(d.name, d.url);
    feedDraft.value = null;
    await loadFeeds();
  } catch (e) {
    feedError.value = String(e);
  } finally {
    feedWorking.value = false;
  }
}
async function feedSync(feed: CalendarFeed): Promise<void> {
  if (feedSyncingId.value) return;
  feedSyncingId.value = feed.id;
  feedError.value = null;
  try {
    await api.calendarFeedSync(feed.id);
    await loadFeeds();
  } catch (e) {
    feedError.value = String(e);
  } finally {
    feedSyncingId.value = null;
  }
}
async function feedToggle(feed: CalendarFeed): Promise<void> {
  try {
    await api.calendarFeedSetEnabled(feed.id, !feed.enabled);
    await loadFeeds();
  } catch (e) {
    feedError.value = String(e);
  }
}
async function feedRemove(feed: CalendarFeed): Promise<void> {
  if (feedArmedId.value !== feed.id) {
    feedArmedId.value = feed.id;
    return;
  }
  feedArmedId.value = null;
  try {
    await api.calendarFeedRemove(feed.id);
    await loadFeeds();
  } catch (e) {
    feedError.value = String(e);
  }
}
async function feedSetColor(feed: CalendarFeed, value: string): Promise<void> {
  try {
    await api.calendarFeedSetColor(feed.id, value || null);
    await loadFeeds();
  } catch (e) {
    feedError.value = String(e);
  }
}
function feedState(feed: CalendarFeed): string {
  if (feedSyncingId.value === feed.id) return t("common.syncing");
  if (!feed.lastSyncedAt) return t("calendar.feedNever");
  return `${t("calendar.feedLastSync", { time: feed.lastSyncedAt })} · ${t("calendar.feedEvents", { n: feed.cachedCount ?? 0 })}`;
}

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

// ---- 数据：每日备份 + 设备包（《架构设计-导出与导入》v1 最小集）----
// 主库 app.db 没有 git 真源（删了不可重建），备份与设备包是它唯一的保险；
// 自动备份在应用启动时由 Rust 侧完成，这里只展示状态并提供手动入口。
const backupStatus = ref<BackupStatus | null>(null);
const backupWorking = ref(false);
const transferError = ref<string | null>(null);
const importOpen = ref(false);

const backupState = computed(() => {
  const s = backupStatus.value;
  if (!s) return t("transfer.backupUnknown");
  if (!s.latest) return t("transfer.backupNone");
  return t("transfer.backupLatest", { file: s.latest, count: s.count });
});

async function loadBackupStatus(): Promise<void> {
  if (!isTauri()) return;
  try {
    backupStatus.value = await api.backupStatus();
  } catch (e) {
    transferError.value = String(e);
  }
}

async function backupNow(): Promise<void> {
  if (backupWorking.value) return;
  backupWorking.value = true;
  transferError.value = null;
  try {
    await api.backupNow();
    await loadBackupStatus();
    pushToast({ kind: "success", message: t("transfer.backupDone") });
  } catch (e) {
    transferError.value = String(e);
    reportError(String(e));
  } finally {
    backupWorking.value = false;
  }
}

async function exportPack(): Promise<void> {
  transferError.value = null;
  try {
    const json = await api.exportPack();
    const saved = await api.saveTextFile(`hivetask-${new Date().toISOString().slice(0, 10)}.export`, json);
    if (saved) pushToast({ kind: "success", message: t("transfer.exported", { path: saved }) });
  } catch (e) {
    transferError.value = String(e);
    reportError(String(e));
  }
}

/** 导入完成后刷新项目列表（看板数据随面板重载拿新库内容）。 */
function onImported(): void {
  void projects.loadProjects();
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
  void loadFeeds();
  void loadBackupStatus();
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

/** 同步间隔选项（关 / 5 / 15 / 30 分钟）——0 = 关。 */
const syncIntervalChoices: { value: string; label: string }[] = SYNC_INTERVAL_CHOICES.map((m) => ({
  value: String(m),
  label: m === 0 ? t("sync.off") : t("sync.minutes", { n: m }),
}));

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
   <div class="settings-content">
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

    <!-- 日历订阅：顶层区块（没有上一级行可挂）→ top-level 去掉子区块缩进，
         左缘与「终端 Shell」这些 setting-row 对齐（用户实测指出的对齐问题） -->
    <div class="setting-byext top-level">
      <div class="byext-head">
        <span class="setting-name">{{ t("settings.calendarFeeds") }}</span>
        <button class="text-btn" :disabled="feedWorking" @click="addFeedDraft">
          {{ t("calendar.feedAdd") }}
        </button>
      </div>
      <p class="byext-desc">{{ t("calendar.feedHint") }}</p>
      <p v-if="feeds.length === 0 && !feedDraft" class="byext-desc">{{ t("calendar.feedEmpty") }}</p>
      <div v-for="feed in feeds" :key="feed.id" class="byext-row" :class="{ off: !feed.enabled }">
        <label class="byext-show">
          <input type="checkbox" :checked="feed.enabled" @change="feedToggle(feed)" />
          <span>{{ t("calendar.feedEnabled") }}</span>
        </label>
        <span class="byext-feedname">
          {{ feed.name }}
          <input
            type="color"
            class="byext-color"
            :value="feed.color ?? DEFAULT_FEED_COLOR"
            :title="t('calendar.feedColor')"
            @change="feedSetColor(feed, ($event.target as HTMLInputElement).value)"
          />
          <button
            v-if="feed.color"
            class="byext-color-reset"
            :title="t('calendar.feedColorReset')"
            @click="feedSetColor(feed, '')"
          >{{ t("calendar.feedColorReset") }}</button>
        </span>
        <span class="byext-meta">{{ feedState(feed) }}</span>
        <button class="text-btn" :disabled="feedSyncingId !== null" @click="feedSync(feed)">
          {{ feedSyncingId === feed.id ? t("common.syncing") : t("calendar.feedSyncNow") }}
        </button>
        <button
          class="text-btn danger"
          :class="{ armed: feedArmedId === feed.id }"
          @click="feedRemove(feed)"
        >
          {{ feedArmedId === feed.id ? t("calendar.feedDeleteArm") : t("calendar.feedDelete") }}
        </button>
      </div>
      <div v-if="feedDraft" class="byext-row">
        <input
          v-model="feedDraft.name"
          class="setting-input byext-feedname"
          :placeholder="t('calendar.feedNamePh')"
          spellcheck="false"
          @keydown.enter="commitFeedDraft"
          @blur="commitFeedDraft"
        />
        <span class="byext-arrow">→</span>
        <input
          v-model="feedDraft.url"
          class="setting-input byext-app"
          :placeholder="t('calendar.feedUrlPh')"
          spellcheck="false"
          @keydown.enter="commitFeedDraft"
          @blur="commitFeedDraft"
        />
        <button class="byext-remove" :title="t('common.cancel')" @click="feedDraft = null">✕</button>
      </div>
      <p v-if="feedError" class="byext-error">{{ feedError }}</p>
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.lunarLine") }}</span>
        <span class="setting-desc">{{ t("settings.lunarLineDesc") }}</span>
      </div>
      <input v-model="settings.lunarLine" class="setting-check" type="checkbox" />
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

    <!-- 数据：每日备份 + 设备包（《架构设计-导出与导入》v1 最小集）——
         主库没有 git 真源，这里是它唯一的保险出口。
         顶层区块（没有上一级行可挂）→ 用 top-level 去掉子区块的缩进，
         左缘与「终端 Shell」「显示状态栏」这些 setting-row 对齐 -->
    <div class="setting-byext top-level">
      <div class="byext-head">
        <span class="setting-name">{{ t("transfer.dataTitle") }}</span>
        <button class="text-btn" :disabled="backupWorking" @click="backupNow">
          {{ backupWorking ? t("common.syncing") : t("transfer.backupNow") }}
        </button>
      </div>
      <p class="byext-desc">{{ t("transfer.backupHint") }}</p>
      <p class="byext-desc">{{ backupState }}</p>
      <div class="data-actions">
        <button class="text-btn" @click="exportPack">{{ t("transfer.export") }}</button>
        <button class="text-btn" @click="importOpen = true">{{ t("transfer.import") }}</button>
      </div>
      <p v-if="transferError" class="byext-error">{{ transferError }}</p>
    </div>

    <div class="setting-row">
      <div class="setting-text">
        <span class="setting-name">{{ t("settings.syncInterval") }}</span>
        <span class="setting-desc">{{ t("settings.syncIntervalDesc") }}</span>
      </div>
      <DropdownMenu
        class="setting-dd"
        :options="syncIntervalChoices"
        :model-value="String(settings.syncIntervalMin)"
        @update:model-value="settings.syncIntervalMin = Number($event)"
      />
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

    <SourceConnectionsDialog
      :open="connectionsOpen"
      @close="connectionsOpen = false"
    />

    <ImportPackDialog :open="importOpen" @close="importOpen = false" @applied="onImported" />

    <GitHubAuthDialog :open="ghAuthOpen" @close="((ghAuthOpen = false), refreshGhLogin())" @success="onAuthSuccess" />
  </div>
</div>
</template>

<style scoped>
/* 滚动容器：全宽 —— 滚动条必须贴窗口右缘（用户指出：限宽加在滚动容器自身上，
   滚动条会悬在屏幕中间，看起来像断了）。限宽与居中由内层 .settings-content 负责。 */
.settings-basic {
  flex: 1;
  overflow-y: auto;
}
.settings-content {
  max-width: max(480px, 60%);
  margin: 0 auto;
  padding: 10px 20px 20px;
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
/* 顶层区块（如「数据备份」）：缩进去掉——它不是任何一行的子项，
   内容左缘要与 setting-row 的一致（用户实测指出的对齐问题） */
.setting-byext.top-level {
  padding-left: 0;
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
/* 日历订阅行小件（.byext-cell* 三个规则曾服务于资源目录行，随资源目录搬去
   「项目」工作区一并删除——留着就是死样式） */
.byext-row.off .byext-feedname,
.byext-row.off .byext-meta {
  opacity: 0.55;
}
.byext-show {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.byext-feedname {
  display: inline-flex;
  align-items: center;
  flex: none;
  min-width: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-md);
  color: var(--text);
  font-weight: 600;
}
.byext-meta {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.byext-color {
  width: 14px;
  height: 14px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: none;
  cursor: pointer;
  vertical-align: -2px;
  margin-left: 4px;
}
.byext-color-reset {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-xs);
  cursor: pointer;
  margin-left: 4px;
  padding: 0;
}
.byext-color-reset:hover {
  color: var(--accent);
}
.byext-feedname {
  cursor: default;
}
.byext-feedname-input {
  width: 150px;
}
/* 数据区块的动作行（刻意不复用 .byext-row：那是可编辑规则行的类，
   设置面板的测试按该类取"最后一条规则"） */
.data-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.text-btn.danger {
  color: var(--danger);
}
.text-btn.danger.armed {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
.text-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.byext-error {
  margin: 6px 0 0;
  font-size: var(--font-sm);
  color: var(--danger);
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
