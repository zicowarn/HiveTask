<script setup lang="ts">
/**
 * 项目底部 omnibar（GitHub 的 Add item 形态）：＋ 按钮 + 输入 + 建议菜单。
 * Board/Table 共用；输入标题回车 = emit create-draft（父组件带上下文建草稿）；
 * 输入 # = 选仓库后点选开放 Issue → emit create-issue。
 * 仓库/Issue 数据本组件自加载（api.repoList / listCachedIssues）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api";
import { useI18n } from "../i18n";
import EditorIcon from "../components/EditorIcon.vue";

const { t } = useI18n();

/** inline：宿主在文档流内（表格 add 行）时用；缺省为容器底部悬浮（看板形态）。 */
withDefaults(defineProps<{ inline?: boolean }>(), { inline: false });

const emit = defineEmits<{
  (e: "createDraft", title: string): void;
  (e: "addFromRepo"): void;
  (e: "openCreateDialog"): void;
  (e: "createIssue", payload: { repoId: string; number: string }): void;
  (e: "close"): void;
  (e: "openChange", open: boolean): void;
}>();

/** 底部输入条：平台不是常显——点新增才出现，外点 / Esc 隐藏。 */
const open = ref(false);
/** omnibar 模式（平台的两个建议项）：create = 输入即新建；repo = 从仓库选条目。 */
const mode = ref<"create" | "repo">("create");
/** 建议菜单开关：omnibar 左侧的 ＋ 图标是按钮——点击才显示建议菜单
 * （平台实测：打开「添加条目」只有输入条，点 ＋ 才弹菜单）。 */
const menuOpen = ref(false);
function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  focusInput();
}
const text = ref("");
const repoId = ref("");
const repoMenuOpen = ref(false);
const repoChoices = ref<
  { id: string; label: string; visibility?: string | null; target: string; remoteUrl?: string | null }[]
>([]);
/** 选中仓库后的开放 Issue 列表（数据源 = 本地仓库缓存库，离线可用——③适配标注）。 */
const issues = ref<{ number: string; title: string }[]>([]);
const loadingIssues = ref(false);
const inputEl = ref<HTMLInputElement | null>(null);

function openBar() {
  open.value = true;
  mode.value = "create";
  menuOpen.value = false;
  repoId.value = "";
  text.value = "";
  emit("openChange", true);
  focusInput();
}
function closeBar() {
  open.value = false;
  menuOpen.value = false;
  text.value = "";
  repoId.value = "";
  issues.value = [];
  emit("openChange", false);
  emit("close");
}
function onDocPointerDown(event: MouseEvent) {
  if (!open.value) return;
  const el = event.target as HTMLElement | null;
  // 宿主行（data-omni-host，即打开本输入条的那一行）也不关——
  // 否则 pointerdown 先关、行 click 再开，再点 ＋ 永远关不掉（点击异常实测）
  if (el && (el.closest(".omnibar") || el.closest("[data-omni-host]"))) return;
  closeBar();
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && open.value) closeBar();
}
function focusInput() {
  requestAnimationFrame(() => {
    // preventScroll：聚焦不要把可滚动的板面滚走
    if (inputEl.value) inputEl.value.focus({ preventScroll: true });
  });
}

async function ensureRepos() {
  if (repoChoices.value.length) return;
  try {
    const rows = (await api.repoList()) as Array<{ id: string; displayName?: string | null; path?: string | null; remoteUrl?: string | null; visibility?: string | null }>;
    repoChoices.value = rows.map((r) => ({
      id: r.id,
      label: r.displayName ?? r.path?.split("/").filter(Boolean).pop() ?? r.remoteUrl ?? r.id,
      visibility: r.visibility ?? null,
      target: r.path ?? r.remoteUrl ?? r.id,
      remoteUrl: r.remoteUrl ?? null,
    }));
  } catch {
    repoChoices.value = [];
  }
}

function onInput() {
  if (text.value.includes("#") && !repoId.value) {
    pickMode("repo");
  }
}
/** 建议菜单两行的点击/激活（平台：Create new issue ⇄ Add item from repository）。 */
function pickMode(next: "create" | "repo") {
  mode.value = next;
  // 输入 # 也要能看见菜单——否则「# 选仓库」这条快路径点了没反应（菜单由 ＋ 开关控制）
  menuOpen.value = true;
  if (next === "repo") {
    void ensureRepos();
    repoMenuOpen.value = true;
    focusInput();
  } else {
    repoMenuOpen.value = false;
    focusInput();
  }
}
/** 选了仓库 = 载入该仓库的开放 Issue 列表。 */
async function pickRepo(id: string) {
  repoId.value = id;
  text.value = "";
  issues.value = [];
  loadingIssues.value = true;
  focusInput();
  const row = repoChoices.value.find((r) => r.id === id);
  if (!row) return;
  try {
    const rows = (await api.listCachedIssues(row.target, "open")) as Array<{ number: string; title: string }>;
    issues.value = rows;
  } catch {
    issues.value = [];
  } finally {
    loadingIssues.value = false;
  }
}
/** 点选 Issue → 通知父组件以引用条目加入。 */
function pickIssue(issue: { number: string }) {
  emit("createIssue", { repoId: repoId.value, number: issue.number });
  issues.value = issues.value.filter((i) => i.number !== issue.number);
}
function clearRepo() {
  repoId.value = "";
  text.value = "";
  focusInput();
}
/** repo 模式下按输入过滤（平台的 "Search or add items"）。 */
const filteredIssues = computed(() => {
  const needle = text.value.trim().toLowerCase();
  if (!needle) return issues.value;
  return issues.value.filter(
    (i) => i.title.toLowerCase().includes(needle) || i.number.toLowerCase().includes(needle),
  );
});
/** 回车：repo 模式 = 加入第一个命中 Issue；否则 emit create-draft。 */
function onEnter() {
  if (repoId.value) {
    const first = filteredIssues.value[0];
    if (first) pickIssue(first);
    text.value = "";
    return;
  }
  const title = text.value.trim();
  if (!title) return;
  emit("createDraft", title);
  text.value = "";
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onKeydown);
});

defineExpose({
  open: openBar,
  close: closeBar,
  focus: focusInput,
});
</script>

<template>
  <!-- GitHub 的底部 omnibar：点新增才出现，外点 / Esc 隐藏 -->
  <div v-if="open" class="omnibar" :class="{ inline }">
    <!-- 建议菜单：由输入条左侧 ＋ 开关控制（平台同款）；内容随模式/输入变化 -->
    <div v-show="menuOpen" class="omni-menu">
      <!-- create 模式 -->
      <template v-if="mode === 'create'">
        <button class="omni-sug active" type="button" @click="emit('openCreateDialog')">
          <EditorIcon name="o.issue-opened" />
          <span class="omni-sug-label">{{ t("project.omniCreate") }}</span>
          <span class="omni-hint">⏎</span>
        </button>
        <button v-if="!text" class="omni-sug" type="button" @click="emit('addFromRepo')">
          <EditorIcon name="o.repo" />
          <span class="omni-sug-label">{{ t("project.omniFromRepo") }}</span>
        </button>
      </template>
      <!-- repo 模式：选仓库（可见性图标：私有锁 / 公开册） -->
      <template v-else-if="!repoId">
        <button
          v-for="(r, ri) in repoChoices"
          :key="r.id"
          class="omni-sug"
          :class="{ active: ri === 0 }"
          type="button"
          @click="pickRepo(r.id)"
        >
          <EditorIcon :name="r.visibility === 'private' ? 'lock' : 'o.repo'" />
          <span class="omni-sug-label">{{ r.label }}</span>
        </button>
        <p v-if="repoChoices.length === 0" class="omni-empty">{{ t("project.bindEmpty") }}</p>
      </template>
      <!-- repo 模式：该仓库开放 Issue 列表 ＋ 保留新建行 -->
      <template v-else>
        <button
          v-for="iss in filteredIssues"
          :key="iss.number"
          class="omni-sug"
          :class="{ active: filteredIssues[0] === iss }"
          type="button"
          @click="pickIssue(iss)"
        >
          <EditorIcon name="o.issue-opened" />
          <span class="omni-sug-label">{{ iss.title }}</span>
          <span class="omni-hint">#{{ iss.number }}</span>
        </button>
        <p v-if="loadingIssues" class="omni-empty">{{ t("list.loading") }}</p>
        <p v-else-if="filteredIssues.length === 0" class="omni-empty">{{ t("project.omniNoIssues") }}</p>
        <button class="omni-sug" type="button" @click="focusInput">
          <EditorIcon name="o.plus" />
          <span class="omni-sug-label">{{ t("project.omniCreate") }}</span>
        </button>
      </template>
    </div>
    <div class="omni-row">
      <button
        class="omni-plus"
        type="button"
        :class="{ on: menuOpen }"
        :title="t('project.omniMenuToggle')"
        @click="toggleMenu"
      >
        <EditorIcon name="o.plus" />
      </button>
      <button v-if="repoId" class="omni-chip" type="button" :title="t('project.omniFromRepo')" @click="clearRepo">
        repo:{{ repoChoices.find((r) => r.id === repoId)?.label ?? "" }}
      </button>
      <input
        ref="inputEl"
        v-model="text"
        class="omni-input"
        :placeholder="repoId ? t('project.omniSearchOrAdd') : t('project.omniPlaceholder')"
        spellcheck="false"
        @input="onInput"
        @keydown.enter="onEnter"
      />
    </div>
  </div>
</template>

<style scoped>
/* 底部 omnibar（GitHub 的 Add item 输入条）：整宽、贴容器底边（overlay）；
   inline 变体（表格 add 行）：随文档流，占位一行 */
.omnibar {
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: 10px;
  z-index: 20;
}
.omnibar.inline {
  position: static;
}
.omni-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
}
.omni-row:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
.omni-plus {
  display: inline-flex;
  border: none;
  background: transparent;
  color: var(--text-dim);
  padding: 3px;
  border-radius: 5px;
  cursor: pointer;
}
.omni-plus:hover,
.omni-plus.on {
  color: var(--accent);
  background: var(--bg-hover);
}
.omni-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: var(--font-base);
  font-family: inherit;
  color: var(--text);
}
.omni-input::placeholder {
  color: var(--text-dim);
}
.omni-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-sm);
  padding: 1px 4px 1px 8px;
  border-radius: 4px;
  background: var(--bg-selected);
  color: var(--accent);
}
.omni-chip:hover {
  text-decoration: underline;
}
/* 建议菜单：贴输入条上沿、非全宽（平台 ~400px，锚左侧）、限高滚动。
   表格 add 行的 td 高度固定（table-layout: fixed），菜单比行高时向下溢出，
   后续表格行会按绘制顺序盖住菜单把它切成数段——提为定位元素（z5）
   让它完整绘制在所有表格行之上 */
.omni-menu {
  position: relative;
  z-index: 5;
  align-self: flex-start;
  width: 420px;
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 6px;
  padding: 4px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}
.omni-sug {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-base);
  text-align: left;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.omni-sug:hover {
  background: var(--bg-hover);
}
/* 激活模式：左侧蓝色竖条（平台的当前模式指示） */
.omni-sug.active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
}
.omni-sug-label {
  flex: 1;
  min-width: 0;
}
.omni-hint {
  flex: none;
  color: var(--text-dim);
  font-size: var(--font-sm);
}
.omni-empty {
  margin: 0;
  padding: 4px 8px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
</style>
