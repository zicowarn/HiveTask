<script setup lang="ts">
/**
 * Application status bar (VS Code style): quiet 24px strip pinned to the
 * window bottom. Left = repository context, right = sync freshness /
 * reachability / gh / language / version — the same three-segment split as
 * QHiveFrame's QHFAppStatusBar (prompts / stats / version), with segments
 * as hover-highlighted "cells".
 *
 * The sync cell reads the per-repo SQLite meta table (migration 005) via
 * the sync-meta store: "last updated" belongs to the data, not the
 * session, so it survives restarts and is tracked per filter bucket.
 * Reachability is tracked passively (gh roundtrip outcomes); clicking the
 * cell runs one user-initiated probe.
 */
import { computed, nextTick, ref } from "vue";
import { storeToRefs } from "pinia";
import { useRepoStore } from "../stores/repo";
import { useIssuesStore } from "../stores/issues";
import { usePullsStore } from "../stores/pulls";
import { useProjectsStore } from "../stores/projects";
import { useKnowledgeStore } from "../stores/knowledge";
import DropdownMenu from "../components/DropdownMenu.vue";
import { useSyncMetaStore } from "../stores/sync-meta";
import { netOnline, probeNow } from "../net";
import { useI18n } from "../i18n";
import { platformName } from "../panels/platform-label";
import { APP_VERSION } from "../app-info";
import { shortOrigin } from "../origin";
import EditorIcon from "../components/EditorIcon.vue";

const props = defineProps<{ workspace: string }>();

const repo = useRepoStore();
const issues = useIssuesStore();
const pulls = usePullsStore();
const projectsStore = useProjectsStore();
const knowledge = useKnowledgeStore();
/** 状态栏点 ⟳ = 刷新项目数据（与面板头部刷新按钮同一入口）。 */
async function refreshProject() {
  await projectsStore.syncSelected();
}
const syncMeta = useSyncMetaStore();
const { t, locale, localeChoice, locales, cycleLocale } = useI18n();
const { current, origin, ghAvailable } = storeToRefs(repo);

/** Cell shows the raw choice ("跟随系统" when following the OS), else the
 * language's self-name — scales to any N. */
const localeLabel = computed(() => {
  if (localeChoice.value === "system") return t("lang.system");
  return locales.find((l) => l.value === locale.value)?.label ?? locale.value;
});

const repoName = computed(() => {
  if (!current.value) return null;
  const parts = current.value.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? current.value;
});

/** 来源标签与运行时路由同源（repo.platform 来自 repo_info 的
 * resolve_target 链）；无 platform = 本地/未知。表与「在 {平台} 打开」
 * 共享（panels/platform-label.ts）。 */
const platformLabel = computed(() => platformName(repo.platform) ?? t("statusbar.local"));

/** 项目分布格：选中项目的按列计数（堆叠条 + 总数），点击跳项目工作区。
 * 应用级数据（projects store 启动时已加载）；无选中项目则隐藏。 */
const projBoard = computed(() => projectsStore.selected);
const projDist = computed(() => {
  const field = projectsStore.statusField;
  if (!field) return [];
  return field.options.map((o) => ({
    id: o.id,
    name: o.name,
    color: o.color,
    count: projectsStore.items.filter((i) => i.fieldValues[field.id] === o.id).length,
  }));
});
const projTotal = computed(() => projDist.value.reduce((sum, d) => sum + d.count, 0));
function gotoProjects() {
  projectsStore.navRequest = { workspace: "projects" };
}

// Freshness is per filter bucket on the data workspaces; on other tabs
// (and when the active bucket was never synced) the cell falls back to the
// latest sync across all buckets — a cell that flickers out on tab
// switches reads as "lost" rather than "not applicable".
/** 选中项目的同步时间（拉线上 Projects 条目时盖章）；与 Issue/PR 的仓库同步是两本账。 */
const projectSyncedAt = computed(() => projectsStore.selected?.syncedAt ?? null);
const projectSyncedLabel = computed(() => (projectSyncedAt.value ? relative(projectSyncedAt.value) : ""));

const syncedAt = computed(() => {
  const bucketKey =
    props.workspace === "issues"
      ? `issues:${issues.state}`
      : props.workspace === "pulls"
        ? `pulls:${pulls.state}`
        : null;
  const times = Object.values(syncMeta.map);
  if (bucketKey) {
    const bucket = syncMeta.map[bucketKey];
    if (bucket) return bucket;
  }
  return times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
});

/** "2026-09-11T02:00:00Z" → "5 分钟前" / "2 hours ago", locale-following. */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSeconds = Math.round((then - Date.now()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 30],
    ["month", 12],
    ["year", Infinity],
  ];
  let value = diffSeconds;
  for (const [unit, span] of units) {
    if (Math.abs(value) < span) {
      return new Intl.RelativeTimeFormat(locale.value, { numeric: "auto" }).format(
        value,
        unit,
      );
    }
    value = Math.round(value / span);
  }
  return iso;
}
const syncedLabel = computed(() => (syncedAt.value ? relative(syncedAt.value) : ""));

// ---- 知识库：当前文件的语言 / 编码 / 换行 / 大小 ----
// 光标行列与制表位要等 CM6 编辑器落地（T6）才有真值，届时补在同一个格里。
const KB_LANGUAGES: Record<string, string> = {
  md: "Markdown",
  markdown: "Markdown",
  mdx: "Markdown",
  json: "JSON",
  jsonc: "JSON",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  csv: "CSV",
  tsv: "TSV",
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  vue: "Vue",
  rs: "Rust",
  py: "Python",
  go: "Go",
  java: "Java",
  rb: "Ruby",
  php: "PHP",
  sh: "Shell",
  zsh: "Shell",
  bash: "Shell",
  html: "HTML",
  htm: "HTML",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  sql: "SQL",
  xml: "XML",
  txt: "Plain Text",
  log: "Log",
  lock: "Lockfile",
};

const kbFile = computed(() => (props.workspace === "knowledge" ? knowledge.selected : null));
const kbLanguage = computed(() => {
  const rel = kbFile.value;
  if (!rel) return "";
  // 非文本格式由预览插件给出准确名字（PDF/Word/表格…）；文本/代码走扩展名映射。
  // 以前这里只有语言映射表，PDF/docx/xlsx 一律显示「纯文本」（用户实测发现）。
  if (knowledge.activeFormat) return knowledge.activeFormat.label;
  const name = rel.split("/").pop() ?? rel;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return KB_LANGUAGES[ext] ?? t("kb.fileTypePlain");
});

/** 分页文档的页码（如「第 3 / 62 页」）——点击可输入页码回车跳转。 */
/** 候选编码（名字用 ICU 规范名，与 kb_read_text 返回的一致，选项本身不翻译）。 */
const ENCODING_CHOICES = ["UTF-8", "GBK", "GB18030", "BIG5", "Shift_JIS", "EUC-KR", "UTF-16LE", "UTF-16BE"];
const encodingOptions = computed(() => {
  const current = knowledge.activeText?.encoding ?? "";
  const ordered = [current, ...ENCODING_CHOICES.filter((name) => name !== current)];
  return ordered.map((name) => ({ value: name, label: name === current ? `${name}（自动探测）` : name }));
});

const kbPageEditing = ref(false);
const kbPageDraft = ref("");
const kbPageInput = ref<HTMLInputElement | null>(null);

function startPageJump(): void {
  if (!knowledge.paging) return;
  kbPageDraft.value = String(knowledge.paging.page);
  kbPageEditing.value = true;
  void nextTick(() => kbPageInput.value?.select());
}

function commitPageJump(): void {
  const page = Number.parseInt(kbPageDraft.value, 10);
  kbPageEditing.value = false;
  if (Number.isFinite(page) && page > 0) knowledge.requestPageJump(page);
}
const kbEol = computed(() => (knowledge.activeText?.eol === "\r\n" ? "CRLF" : "LF"));
/** 字数：非空白字符数；有拉丁词时附上词数（纯中文不显示"0 词"）。 */
const kbWordCount = computed(() => {
  const stats = knowledge.stats;
  if (!stats) return "";
  const chars = stats.chars.toLocaleString(locale.value);
  if (stats.words === 0) return t("kb.wordCountChars", { chars });
  return t("kb.wordCount", { chars, words: stats.words.toLocaleString(locale.value) });
});
const kbSize = computed(() => {
  // 非文本格式没有 activeText，但尺寸同样要显示（插件解析时已知道）
  const size = knowledge.activeText?.size ?? knowledge.activeFormat?.size;
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
});

async function probe() {
  await probeNow();
}
</script>

<template>
  <footer class="statusbar">
    <div class="status-left">
      <button
        class="status-cell repo-cell"
        :title="current ?? t('app.repoPick')"
        @click="repo.pick()"
      >
        <span class="cell-mark">⬡</span>
        {{ repoName ?? t("statusbar.noRepo") }}
      </button>
      <span v-if="origin" class="status-cell" :title="origin">{{ shortOrigin(origin) }}</span>
      <span
        v-if="current"
        class="status-cell source-cell"
        :title="repo.visibility ? t(repo.visibility === 'private' ? 'repo.visibilityPrivate' : 'repo.visibilityPublic') : undefined"
      >
        <EditorIcon
          v-if="repo.visibility"
          :name="repo.visibility === 'private' ? 'lock' : 'unlock'"
        />
        {{ platformLabel }}
      </span>
      <!-- 项目上下文（与库信息同构）：名称 + 私有锁（本地即私有）+
           条目分布（仅在有条目时）。空板也显示，否则该格整段消失。 -->
      <button
        v-if="projBoard"
        class="status-cell proj-cell"
        :title="projTotal > 0
          ? projDist.map((d) => `${d.name} ${d.count}`).join(' · ')
          : t('project.visibilityTip')"
        @click="gotoProjects"
      >
        <span class="proj-mark">◫</span>
        {{ projBoard.displayName }}
        <span class="proj-lock" :title="t('project.visibilityTip')">
          <EditorIcon name="lock" />
        </span>
        <template v-if="projTotal > 0">
          <span class="proj-bar">
            <span
              v-for="d in projDist"
              :key="d.id"
              class="proj-seg"
              :style="{ background: d.color, flexGrow: d.count }"
            ></span>
          </span>
          {{ projTotal }}
        </template>
      </button>
    </div>

    <div class="status-right">
      <!-- 知识库：当前文件信息（右对齐段，与 VS Code 同侧） -->
      <template v-if="kbFile">
        <span v-if="knowledge.cursor" class="status-cell kb-cursor-cell">
          {{ t("kb.cursorPos", { line: knowledge.cursor.line, col: knowledge.cursor.col }) }}
        </span>
        <span class="status-cell" :title="t('kb.indentTip')">
          {{ t("kb.indentSize", { n: knowledge.indentWidth }) }}
        </span>
        <span v-if="knowledge.stats" class="status-cell" :title="t('kb.wordCountTip')">
          {{ kbWordCount }}
        </span>
        <span class="status-cell kb-lang-cell" :title="knowledge.selected ?? ''">{{ kbLanguage }}</span>
        <span v-if="knowledge.section" class="status-cell kb-section-cell" :title="knowledge.section">
          {{ knowledge.section }}
        </span>
        <span v-if="knowledge.paging" class="status-cell kb-page-cell">
          <template v-if="!kbPageEditing">
            <button class="kb-page" :title="t('kb.pageJumpTip')" @click="startPageJump">
              {{ t("kb.pageOf", { page: knowledge.paging.page, total: knowledge.paging.total }) }}
            </button>
          </template>
          <input
            v-else
            ref="kbPageInput"
            v-model="kbPageDraft"
            class="kb-page-input"
            type="text"
            inputmode="numeric"
            @keydown.enter="commitPageJump"
            @keydown.esc="kbPageEditing = false"
            @blur="commitPageJump"
          />
        </span>
        <span v-if="knowledge.activeText" class="status-cell kb-enc-cell">
          <!-- 编码切换（③适配，用户点名要；OFV 无此能力——它不回写也没有切换 UI）：
               选一个编码 → 按它重新解码当前文件；保存链路按此编码回写（= 转码另存） -->
          <DropdownMenu
            :options="encodingOptions"
            :model-value="knowledge.activeText.encoding"
            @update:model-value="knowledge.requestEncoding(String($event))"
          >
            <template #trigger="{ open, toggle }">
              <button
                class="kb-enc"
                :class="{ open }"
                :title="t('kb.encodingSwitchTip')"
                @click="toggle"
              >
                {{ knowledge.activeText.encoding }}
              </button>
            </template>
          </DropdownMenu>
        </span>
        <span v-if="knowledge.activeText" class="status-cell" :title="t('kb.eolTip')">{{ kbEol }}</span>
        <span v-if="kbSize" class="status-cell">{{ kbSize }}</span>
      </template>
      <button
        v-if="netOnline !== null"
        class="status-cell net-cell"
        :class="{ online: netOnline, offline: !netOnline }"
        :title="netOnline ? t('statusbar.onlineTitle') : t('statusbar.offlineTitle')"
        @click="probe"
      >
        ● {{ netOnline ? t("statusbar.online") : t("statusbar.offline") }}
      </button>
      <!-- Issue / PR 的同步格（仓库数据；与项目数据是两本账） -->
      <span
        v-if="syncedAt"
        class="status-cell"
        :title="t('statusbar.syncedAt', { time: new Date(syncedAt).toLocaleString() })"
      >
        <span class="sync-mark">⟳</span> {{ syncedLabel }}
      </span>
      <!-- 项目数据同步格（独立一格：选中项目即显示，点击 = 刷新项目数据） -->
      <button
        v-if="projectsStore.selected"
        class="status-cell project-sync-cell"
        :title="
          projectSyncedAt
            ? t('statusbar.projectSyncedAt', { time: new Date(projectSyncedAt).toLocaleString() })
            : t('statusbar.projectNeverSynced')
        "
        @click="refreshProject()"
      >
        <span class="proj-mark">◫</span>
        <span class="sync-mark">⟳</span>
        {{ projectSyncedAt ? projectSyncedLabel : t("project.neverSynced") }}
      </button>
      <span
        v-if="ghAvailable !== null"
        class="status-cell gh-cell"
        :class="{ ok: ghAvailable, missing: !ghAvailable }"
        :title="ghAvailable ? t('statusbar.ghOk') : t('statusbar.ghMissing')"
      >
        ● gh
      </span>
      <button
        class="status-cell lang-cell"
        :title="t('lang.switch')"
        @click="cycleLocale()"
      >
        {{ localeLabel }}
      </button>
      <span class="status-cell version-cell">HiveTask v{{ APP_VERSION }}</span>
    </div>
  </footer>
</template>

<style scoped>
.statusbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 24px;
  background: var(--bg-app);
  border-top: 1px solid var(--border);
  font-size: var(--font-sm);
  color: var(--text-dim);
  user-select: none;
}
.status-left,
.status-right {
  display: flex;
  align-items: stretch;
  height: 100%;
  min-width: 0;
}
/* Cells are full-height so hover highlight reads like VS Code segments. */
.kb-enc-cell {
  display: inline-flex;
  align-items: center;
}
.kb-enc {
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-sm);
  cursor: pointer;
}
.kb-enc:hover,
.kb-enc.open {
  color: var(--text);
}
.kb-section-cell {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-page-cell {
  display: inline-flex;
  align-items: center;
}
.kb-page {
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-sm);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.kb-page:hover {
  color: var(--accent);
}
.kb-page-input {
  width: 44px;
  height: 16px;
  padding: 0 4px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-sm);
}
.status-cell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  white-space: nowrap;
}
.status-left .status-cell:first-child {
  padding-left: 10px;
}
.status-right .status-cell:last-child {
  padding-right: 10px;
}
button.status-cell {
  border: none;
  background: transparent;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.status-cell:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.cell-mark {
  color: var(--accent);
  font-size: var(--font-sm);
}
.repo-cell {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.source-cell {
  color: var(--accent);
}
.proj-cell {
  max-width: 300px;
}
.proj-mark {
  color: var(--accent);
}
.proj-lock {
  display: inline-flex;
  align-items: center;
  color: var(--text-dim);
}
.proj-bar {
  display: inline-flex;
  width: 56px;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg-hover);
}
.proj-seg {
  min-width: 2px;
}
.net-cell.online {
  color: var(--success);
}
.net-cell.offline {
  color: var(--warning);
}
/* The ⟳ glyph reads smaller than the filled ● dots at the same font
   size — bump it so the status marks align visually. */
.project-sync-cell .proj-mark {
  margin-right: 4px;
  color: var(--text-dim);
}
.sync-mark {
  font-size: var(--icon-size, 14px);
  line-height: 1;
}
.gh-cell.ok {
  color: var(--success);
}
.gh-cell.missing {
  color: var(--danger);
}
.version-cell {
  color: var(--text-dim);
  opacity: 0.8;
}
</style>
