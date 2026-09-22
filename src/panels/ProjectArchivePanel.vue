<script setup lang="ts">
/**
 * 已归档条目 Editor（「项目」工作区分组）。形态依据 GitHub Projects 的
 * 「Archived items」页（2026-09-22 取证：项目 ⋯ 菜单 → Archived items，页标题
 * Archive，顶部「Filter by keyword or by field」，列表每行 = 复选框 + 状态图标 +
 * 标题 + #编号 + `archived on <日期> by <人>`，勾选后 Restore）。
 *
 * 两处**桌面适配**（标注）：
 * ① 平台的家是项目头部 ⋯ 菜单里的独立页；本应用没有项目 ⋯ 菜单 → 落成「项目」
 *    分类下的独立 Editor（与「资源目录」「项目分析」同构，走 Editor 切换器进入）。
 * ② 平台的 `by <人>` 在本地单用户语境没有信息量 → 只显归档日期；另给行内「还原」
 *    省掉先勾选再点 Restore 的两步（顶部全选 + 批量还原照平台保留）。
 *
 * 「归档 = 移出所有视图、保留条目上下文」的排除在 store 的 preSliceItems 单点做，
 * 本面板是归档项唯一还会露面的地方（与 filteredItems 互补、不相交）。
 */
import { computed, ref } from "vue";
import PanelShell from "../workbench/PanelShell.vue";
import EditorIcon from "../components/EditorIcon.vue";
import LoadStateHint from "../components/LoadStateHint.vue";
import { useI18n } from "../i18n";
import { useProjectsStore } from "../stores/projects";
import { itemTitle, shortDate } from "./item-fields";
import type { ProjectItem } from "../api";

defineProps<{ leafId?: string; panelType?: string }>();

const { t } = useI18n();
const store = useProjectsStore();

/** 关键字筛选（平台：Filter by keyword or by field——这里接标题/编号/仓库）。 */
const query = ref("");
const checked = ref<string[]>([]);

function haystack(item: ProjectItem): string {
  return `${itemTitle(item)} ${item.number ?? ""} ${item.repoLabel ?? ""}`.toLowerCase();
}

const rows = computed(() => {
  const q = query.value.trim().toLowerCase();
  return q ? store.archivedItems.filter((i) => haystack(i).includes(q)) : store.archivedItems;
});

const allChecked = computed(
  () => rows.value.length > 0 && rows.value.every((i) => checked.value.includes(i.id)),
);

function toggleAll(): void {
  checked.value = allChecked.value ? [] : rows.value.map((i) => i.id);
}
function toggle(id: string): void {
  checked.value = checked.value.includes(id)
    ? checked.value.filter((x) => x !== id)
    : [...checked.value, id];
}

/** 还原（单条与批量同径）：条目回到各视图，本列表随之少一行。 */
async function restore(ids: string[]): Promise<void> {
  for (const id of ids) await store.archiveItem(id, false);
  checked.value = checked.value.filter((id) => !ids.includes(id));
}

/** 状态图标与卡片同源：Issue 开/闭（绿/紫）、PR 用 PR 图标、草稿无。 */
function stateIconOf(item: ProjectItem): string | null {
  if (item.kind === "draft") return null;
  if (item.kind === "pull") return "pull";
  const state = (item.entity?.state ?? "").toUpperCase();
  return state === "CLOSED" ? "o.issue-closed" : "o.issue-opened";
}
function stateColorOf(item: ProjectItem): string {
  const state = (item.entity?.state ?? "").toUpperCase();
  return state === "CLOSED" || state === "MERGED" ? "var(--merged)" : "var(--success)";
}
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <div class="ar-wrap">
      <LoadStateHint v-if="!store.selected" state="empty" :text="t('archive.noProject')" />
      <LoadStateHint v-else-if="store.loading" state="loading" />
      <template v-else>
        <div class="ar-search-box">
          <EditorIcon name="o.search" class="ar-search-icon" />
          <input
            v-model="query"
            class="ar-search"
            :placeholder="t('archive.filterPlaceholder')"
            spellcheck="false"
          />
        </div>

        <div class="ar-bar">
          <label class="ar-all">
            <input type="checkbox" :checked="allChecked" @change="toggleAll" />
            <span>{{ t("archive.selectAll") }}</span>
          </label>
          <span class="ar-count">{{ t("archive.count", { n: String(rows.length) }) }}</span>
          <button
            v-if="checked.length"
            class="ar-restore"
            type="button"
            @click="restore(checked)"
          >{{ t("project.actRestore") }} ({{ checked.length }})</button>
        </div>

        <LoadStateHint
          v-if="rows.length === 0"
          state="empty"
          :text="query ? t('archive.noMatch') : t('archive.empty')"
        />
        <ul v-else class="ar-list">
          <li v-for="item in rows" :key="item.id" class="ar-row" @click="toggle(item.id)">
            <input
              type="checkbox"
              :checked="checked.includes(item.id)"
              @click.stop="toggle(item.id)"
            />
            <EditorIcon
              v-if="stateIconOf(item)"
              :name="stateIconOf(item)!"
              class="ar-icon"
              :style="{ color: stateColorOf(item) }"
            />
            <span class="ar-title" :class="{ ghosty: item.ghost }">{{ itemTitle(item) }}</span>
            <span v-if="item.number" class="ar-num">#{{ item.number }}</span>
            <span class="ar-date">{{ t("archive.archivedOn", { date: shortDate(item.archivedAt) }) }}</span>
            <button class="ar-restore-one" type="button" @click.stop="restore([item.id])">
              {{ t("project.actRestore") }}
            </button>
          </li>
        </ul>
      </template>
    </div>
  </PanelShell>
</template>

<style scoped>
.ar-wrap {
  /* 与「资源目录」「项目分析」两个同代 Editor 同留白（10/14/20） */
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px 20px;
}
.ar-search-box {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 560px;
  margin: 0 auto;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0 9px;
}
.ar-search-box:focus-within {
  border-color: var(--accent);
}
.ar-search-icon {
  flex: none;
  width: var(--icon-size, 14px);
  height: var(--icon-size, 14px);
  color: var(--text-dim);
}
.ar-search {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-base);
  font-family: inherit;
  padding: 5px 0;
  outline: none;
}
.ar-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 900px;
  margin: 10px auto 0;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
  font-size: var(--font-base);
}
.ar-all {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.ar-count {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.ar-restore {
  margin-left: auto;
  height: 24px;
  padding: 0 12px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  font-size: var(--font-md);
  font-family: inherit;
  cursor: pointer;
}
.ar-list {
  list-style: none;
  margin: 0 auto;
  padding: 0;
  max-width: 900px;
}
.ar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 4px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.ar-row:hover {
  background: var(--bg-hover);
}
.ar-row .editor-icon {
  flex: none;
}
.ar-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-base);
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ar-title.ghosty {
  color: var(--text-dim);
}
.ar-num,
.ar-date {
  flex: none;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.ar-restore-one {
  flex: none;
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  font-family: inherit;
  cursor: pointer;
}
.ar-restore-one:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
