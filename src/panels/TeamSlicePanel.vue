<script setup lang="ts">
/**
 * Team items 左导航主体（平台 Slicer，2026-09 取证 + 用户对照截图定版）：
 * 全部内容**常驻导航列内**，无弹层——
 * 顶行 = 字段名 ▾（点击弹出 Slice by 字段切换菜单）+ 同行右侧 Deselect（清除选中）；
 * 值列表 = 行首 ✓ + 色环/头像 + 名称与描述（两行）+ 右侧计数胶囊；
 * 底部 = Show empty values / Hide empty values（零条目值的显隐，随视图配置持久化）。
 */
import { computed } from "vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useProjectsStore } from "../stores/projects";
import { useI18n } from "../i18n";

const store = useProjectsStore();
const { t } = useI18n();

/** 值列表：默认只显示有条目的值（平台实测 In progress/Done，零条目值
 *  要点 Show empty values 才出现）；「无 X」聚合行有缺值条目时恒显示。 */
const visibleRows = computed(() => {
  const rows = store.sliceRows;
  return store.view.sliceShowEmpty ? rows : rows.filter((r) => r.count > 0);
});

const emptyToggleLabel = computed(() =>
  store.view.sliceShowEmpty ? t("project.hideEmptyValues") : t("project.showEmptyValues"),
);

function onSliceFieldPick(value: string | string[]) {
  const first = Array.isArray(value) ? value[0] : value;
  store.setSliceField(first || null);
}

function onSliceAction(value: string) {
  if (value === "__noslice__") store.setSliceField(null);
}
</script>

<template>
  <div class="tsp">
    <!-- 顶行：字段名 ▾（Slice by 字段切换）+ 同行 Deselect -->
    <div class="tsp-head">
      <DropdownMenu
        class="tsp-field-dd"
        :sections="[{ title: t('project.sliceBy'), options: store.sliceFieldChoices }]"
        :model-value="store.view.sliceFieldId ?? ''"
        :menu-width="192"
        hide-check
        :action="{ value: '__noslice__', label: t('project.noSlicing') }"
        action-bottom
        @update:model-value="onSliceFieldPick"
        @action="onSliceAction"
      >
        <template #trigger="{ toggle: toggleField }">
          <button class="tsp-field" type="button" @click="toggleField">
            <span class="tsp-field-label">{{ store.sliceFieldName }}</span>
            <EditorIcon name="o.triangle-down" />
          </button>
        </template>
      </DropdownMenu>
      <button class="tsp-deselect" type="button" @click="store.setSliceValue(null)">
        {{ t("project.deselect") }}
      </button>
    </div>
    <!-- 值列表：✓ + 色环/头像 + 名称/描述 + 计数 -->
    <div class="tsp-list" role="listbox" :aria-label="store.sliceFieldName">
      <button
        v-for="row in visibleRows"
        :key="row.value"
        class="tsp-row"
        :class="{ on: row.value === (store.view.sliceValue ?? '') }"
        type="button"
        role="option"
        :aria-selected="row.value === (store.view.sliceValue ?? '')"
        @click="store.setSliceValue(row.value)"
      >
        <span class="tnr-check" :class="{ on: row.value === (store.view.sliceValue ?? '') }">
          <EditorIcon name="o.check" />
        </span>
        <img v-if="row.avatar" class="tsp-avatar" :src="row.avatar" alt="" />
        <span
          v-else-if="row.color"
          class="tsp-ring"
          :style="{ borderColor: row.color }"
        ></span>
        <span v-else class="tsp-slot"></span>
        <span class="tsp-main">
          <span class="tsp-name">{{ row.label }}</span>
          <span v-if="row.description" class="tsp-desc">{{ row.description }}</span>
        </span>
        <span class="tnr-count">{{ row.count }}</span>
      </button>
    </div>
    <!-- 底部：零条目值的显隐开关 -->
    <div class="tsp-foot">
      <button
        class="tsp-empty-toggle"
        type="button"
        @click="store.setSliceShowEmpty(!store.view.sliceShowEmpty)"
      >
        {{ emptyToggleLabel }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tsp {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
/* 顶行：字段名 ▾ 左（粗体大字）、Deselect 右（次级色） */
.tsp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: none;
  padding: 12px 12px 8px;
}
.tsp-field-dd {
  min-width: 0;
}
.tsp-field {
  display: flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  font-size: var(--font-xl);
  font-weight: 600;
  padding: 0;
  cursor: pointer;
}
.tsp-field .editor-icon {
  color: var(--text-dim);
}
.tsp-field-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tsp-deselect {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: var(--font-base);
  padding: 4px 6px;
  border-radius: 5px;
  cursor: pointer;
}
.tsp-deselect:hover {
  color: var(--text);
  background: var(--bg-hover);
}
/* 值列表：两行式（名称 + 描述）。按内容收缩、不撑满列高——
   底部空值开关要紧跟列表（沉底曾被判位置不对） */
.tsp-list {
  flex: none;
}
.tsp-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-top: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.tsp-row:first-child {
  border-top: none;
}
.tsp-row:hover,
.tsp-row.on {
  background: var(--bg-hover);
}
.tsp-row .tnr-check {
  flex: none;
  display: inline-flex;
  margin-top: 2px;
  color: var(--text-dim);
  visibility: hidden;
}
.tsp-row .tnr-check.on {
  visibility: visible;
}
.tsp-avatar {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  margin-top: 1px;
}
/* 单选值的色环（平台 donut 形态：透明芯 + 2px 色圈） */
.tsp-ring {
  flex: none;
  width: 14px;
  height: 14px;
  margin: 3px 3px 0;
  border: 2px solid var(--border);
  border-radius: 50%;
}
.tsp-slot {
  flex: none;
  width: 20px;
}
.tsp-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tsp-name {
  font-size: var(--font-base);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tsp-desc {
  font-size: var(--font-base);
  color: var(--text-dim);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.tsp-foot {
  display: flex;
  justify-content: flex-end;
  flex: none;
  padding: 6px 12px 12px;
}
.tsp-empty-toggle {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-family: inherit;
  font-size: var(--font-base);
  padding: 4px 6px;
  border-radius: 5px;
  cursor: pointer;
}
.tsp-empty-toggle:hover {
  color: var(--text);
  background: var(--bg-hover);
}
</style>
