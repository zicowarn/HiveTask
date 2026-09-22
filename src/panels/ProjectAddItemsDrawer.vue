<script setup lang="ts">
/**
 * Add items to project（平台右侧抽屉的复刻）：
 *   头部 = 标题 + 关闭
 *   主体 = 仓库选择器 + 搜索框 + 全选 + 多选列表 + 未加入提示
 *   底部 = 「Add selected items」批量加入（落到调用方给定的目标格）
 * 列表来源 = 该仓库缓存的 open Issue / PR，**排除已在本项目的条目**（平台同款：
 * 加过的条目不再出现，并有计数提示）。
 */
import { computed, ref, watch } from "vue";
import { api } from "../api";
import { useProjectsStore } from "../stores/projects";
import { useI18n } from "../i18n";
import SideDrawer from "../components/SideDrawer.vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import EditorIcon from "../components/EditorIcon.vue";
import LoadStateHint from "../components/LoadStateHint.vue";

const props = defineProps<{
  open: boolean;
  /** 仓库候选（项目绑定优先 + 全部登记仓库兜底）。 */
  repos: { value: string; label: string; target: string }[];
  /** 默认仓库（绑定仓库的第一个）。 */
  defaultRepoId?: string;
  /** 加入落点：调用方当前的列 / 泳道段（null = 第一列 / 不写段）。 */
  targetColumnId?: string | null;
  targetLaneId?: string | null;
}>();
const emit = defineEmits<{ close: [] }>();

const store = useProjectsStore();
const { t } = useI18n();

interface Row {
  key: string;
  kind: "issue" | "pull";
  number: string;
  title: string;
}

const repoId = ref("");
const search = ref("");
const rows = ref<Row[]>([]);
const loading = ref(false);
const selected = ref<string[]>([]);
const adding = ref(false);

const activeRepo = computed(() => props.repos.find((r) => r.value === repoId.value) ?? null);
/** 仓库下拉项：私有仓带锁图标（平台同款）。 */
const repoOptions = computed(() =>
  props.repos.map((r) => ({
    value: r.value,
    label: r.label,
    icon: (r as { visibility?: string | null }).visibility === "private" ? "lock" : "o.repo",
  })),
);

/** 载入该仓库的 open Issue / PR，并剔除已在本项目的条目。 */
async function loadRows() {
  const repo = activeRepo.value;
  if (!repo) {
    rows.value = [];
    return;
  }
  loading.value = true;
  try {
    const [issues, pulls] = await Promise.all([
      api.listCachedIssues(repo.target, "open").catch(() => []),
      api.listCachedPulls(repo.target, "open").catch(() => []),
    ]);
    const onBoard = new Set(
      store.items.filter((i) => i.repoId === repo.value).map((i) => `${i.kind}:${i.number ?? ""}`),
    );
    rows.value = [
      ...issues.map((i) => ({
        key: `issue:${i.number}`,
        kind: "issue" as const,
        number: i.number,
        title: i.title,
      })),
      ...pulls.map((p) => ({
        key: `pull:${p.number}`,
        kind: "pull" as const,
        number: String(p.number),
        title: p.title,
      })),
    ].filter((r) => !onBoard.has(r.key));
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    repoId.value = props.defaultRepoId ?? props.repos[0]?.value ?? "";
    search.value = "";
    selected.value = [];
    void loadRows();
  },
);
watch(repoId, () => {
  if (!props.open) return;
  selected.value = [];
  void loadRows();
});
// 仓库候选是异步载入的（打开时 registry 才拉全量）——候选到位后补一次初始化
watch(
  () => props.repos,
  (repos) => {
    if (!props.open || repoId.value || repos.length === 0) return;
    repoId.value = props.defaultRepoId ?? repos[0]!.value;
    void loadRows();
  },
);
// 加入成功后 store.items 变化 → 重新载入即自动排除已加入项
watch(
  () => store.items,
  () => {
    if (props.open && !adding.value) void loadRows();
  },
);

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  if (!needle) return rows.value;
  return rows.value.filter(
    (r) => r.title.toLowerCase().includes(needle) || r.number.includes(needle),
  );
});
const allSelected = computed(
  () => filtered.value.length > 0 && filtered.value.every((r) => selected.value.includes(r.key)),
);
function toggleAll() {
  selected.value = allSelected.value ? [] : filtered.value.map((r) => r.key);
}
function toggleRow(key: string) {
  selected.value = selected.value.includes(key)
    ? selected.value.filter((k) => k !== key)
    : [...selected.value, key];
}

/** 批量加入：逐条 addItem → 落到目标格（列 + 泳道段）。 */
async function addSelected() {
  const repo = activeRepo.value;
  if (!store.selected || !repo || selected.value.length === 0 || adding.value) return;
  adding.value = true;
  try {
    for (const key of selected.value) {
      const [kind, number] = key.split(":");
      const created = await store.addItem({
        projectId: store.selected.id,
        kind: kind === "pull" ? "pull" : "issue",
        repoId: repo.value,
        number: number ?? "",
      });
      if (!created) continue;
      const col = props.targetColumnId ?? null;
      if (col !== null) await store.moveItem(created.id, col);
      const lane = store.swimlaneField;
      if (lane && props.targetLaneId !== null && props.targetLaneId !== undefined) {
        await store.setFieldValue(
          created.id,
          lane.id,
          props.targetLaneId === "" ? undefined : props.targetLaneId,
        );
      }
    }
    selected.value = [];
    await loadRows();
  } finally {
    adding.value = false;
  }
}
</script>

<template>
  <SideDrawer :open="open" :title="t('project.addItemsTitle')" @close="emit('close')">
    <div class="ai-bar">
      <DropdownMenu
        class="ai-repo"
        :options="repoOptions"
        :model-value="repoId"
        :placeholder="t('project.pickRepo')"
        @update:model-value="repoId = $event as string"
      />
      <span class="ai-search-box">
        <svg class="ai-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.5 10.5 14 14" />
        </svg>
        <input
          v-model="search"
          class="ai-search"
          :placeholder="t('project.searchItemsPlaceholder')"
          spellcheck="false"
        />
      </span>
    </div>

    <label class="ai-all">
      <input type="checkbox" :checked="allSelected" @change="toggleAll" />
      <span>{{ t("project.selectAllItems") }}</span>
    </label>

    <LoadStateHint v-if="loading" state="loading" />
    <ul v-else class="ai-list">
      <li v-for="row in filtered" :key="row.key" class="ai-row" @click="toggleRow(row.key)">
        <input
          type="checkbox"
          :checked="selected.includes(row.key)"
          @click.stop="toggleRow(row.key)"
        />
        <EditorIcon :name="row.kind === 'pull' ? 'pull' : 'o.issue-opened'" />
        <span class="ai-title">{{ row.title }}</span>
        <span class="ai-num">#{{ row.number }}</span>
      </li>
    </ul>
    <LoadStateHint v-if="!loading && filtered.length === 0" state="empty" :text="t('project.omniNoIssues')" />
    <p v-else-if="!loading" class="ai-hint">{{ t("project.notAddedHint", { n: String(filtered.length) }) }}</p>

    <template #footer>
      <button
        class="ai-add"
        type="button"
        :disabled="selected.length === 0 || adding"
        @click="addSelected"
      >
        {{ t("project.addSelectedItems") }}<template v-if="selected.length"> ({{ selected.length }})</template>
      </button>
    </template>
  </SideDrawer>
</template>

<style scoped>
.ai-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.ai-repo {
  width: 180px;
  flex: none;
}
.ai-search-box {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 9px;
}
.ai-search-box:focus-within {
  border-color: var(--accent);
}
.ai-search-icon {
  flex: none;
  width: var(--icon-size, 14px);
  height: var(--icon-size, 14px);
  color: var(--text-dim);
}
.ai-search {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  font-size: var(--font-base);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  color: var(--text);
  padding: 4px 0;
  outline: none;
}
.ai-all {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  border-bottom: 1px solid var(--border);
  font-size: var(--font-base);
  color: var(--text);
  cursor: pointer;
}
.ai-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ai-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.ai-row:hover {
  background: var(--bg-hover);
}
.ai-row .editor-icon {
  color: var(--text-dim);
  flex: none;
}
.ai-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-base);
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ai-num {
  flex: none;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.ai-empty,
.ai-hint {
  margin: 10px 4px 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
/* 未加入提示：平台为居中一行 */
.ai-hint {
  text-align: center;
}
.ai-add {
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: var(--font-base);
  font-family: inherit;
  cursor: pointer;
}
.ai-add:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
