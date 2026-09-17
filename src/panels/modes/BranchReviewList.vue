<script setup lang="ts">
/**
 * 本地分支 review 列表（PR 工作区本地形态）：base 下拉 + 领先分支清单。
 * 选中分支后详情面板（BranchReviewDetail）呈现 diff 与合并流程。
 */
import { onMounted } from "vue";
import { storeToRefs } from "pinia";
import { useBranchReviewStore } from "../../stores/branchReview";
import { useI18n } from "../../i18n";
import DropdownMenu from "../../components/DropdownMenu.vue";

const store = useBranchReviewStore();
const { branches, base, selected, loading, error } = storeToRefs(store);
const { t } = useI18n();

onMounted(() => {
  void store.loadBranches();
});
</script>

<template>
  <div class="br-list">
    <div class="br-bar">
      <label class="br-base">
        <span class="br-base-label">{{ t("branchReview.base") }}</span>
        <DropdownMenu
          class="br-base-dd"
          :options="store.baseChoices.map((n) => ({ value: n, label: n }))"
          :model-value="base ?? ''"
          @update:model-value="store.setBase($event as string)"
        />
      </label>
      <span v-if="loading" class="br-loading">{{ t("list.loading") }}</span>
    </div>

    <p v-if="error" class="br-error">{{ error }}</p>
    <p v-else-if="branches.filter((b) => b.ahead > 0).length === 0" class="br-empty">
      {{ t("branchReview.empty") }}
    </p>

    <ul class="br-rows">
      <li
        v-for="b in branches.filter((x) => x.ahead > 0)"
        :key="b.name"
        class="br-row"
        :class="{ active: selected === b.name }"
        @click="store.select(b.name)"
      >
        <span class="br-name">{{ b.name }}</span>
        <span class="br-counts">
          <span v-if="b.ahead > 0" class="br-ahead">↑{{ b.ahead }}</span>
          <span v-if="b.behind > 0" class="br-behind">↓{{ b.behind }}</span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.br-list {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.br-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
}
.br-base {
  display: flex;
  align-items: center;
  gap: 6px;
}
.br-base-label {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.br-base-dd {
  width: 140px;
}
.br-loading {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.br-error {
  margin: 8px 12px 0;
  padding: 8px 10px;
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
}
.br-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: var(--font-md);
  padding: 20px 0;
}
.br-rows {
  list-style: none;
  margin: 0;
  padding: 4px 6px;
  overflow-y: auto;
}
.br-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 6px;
  font-size: var(--font-md);
  color: var(--text);
  cursor: pointer;
}
.br-row:hover {
  background: var(--bg-hover);
}
.br-row.active {
  background: var(--bg-selected);
}
.br-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.br-counts {
  display: inline-flex;
  gap: 6px;
  flex: none;
}
.br-ahead {
  color: var(--success);
}
.br-behind {
  color: var(--warning);
}
</style>
