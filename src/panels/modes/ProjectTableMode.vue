<script setup lang="ts">
/**
 * Table view — the same projected data as the Board, rendered as rows
 * (design: "Board / Table are two projections of the same cached data,
 * no extra storage"). Columns: title / status select / priority dot / repo.
 */
import { computed } from "vue";
import { storeToRefs } from "pinia";
import { useProjectsStore } from "../../stores/projects";
import { useI18n } from "../../i18n";

const store = useProjectsStore();
const { items, statusField, priorityField } = storeToRefs(store);
const { t } = useI18n();

const rows = computed(() => items.value);
const priorityOptions = computed(() => priorityField.value?.options ?? []);

function statusName(item: (typeof items.value)[number]): string {
  if (!statusField.value) return "";
  const optionId = item.fieldValues[statusField.value.id];
  return statusField.value.options.find((o) => o.id === optionId)?.name ?? "—";
}

function titleOf(item: (typeof items.value)[number]): string {
  if (item.kind === "draft") return item.draftTitle ?? "";
  return `#${item.number ?? "?"} ${item.draftTitle ?? ""}`.trim();
}

function tagOf(item: (typeof items.value)[number]): string {
  if (item.ghost) return t("project.ghost");
  if (item.kind === "draft") return t("project.draftTag");
  return item.repoLabel ?? "";
}

function priorityId(item: (typeof items.value)[number]): string {
  return priorityField.value ? (item.fieldValues[priorityField.value.id] ?? "") : "";
}

function priorityName(item: (typeof items.value)[number]): string {
  const id = priorityId(item);
  return priorityOptions.value.find((o) => o.id === id)?.name ?? "—";
}
</script>

<template>
  <div class="tbl-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th>{{ t("project.colTitle") }}</th>
          <th>{{ t("project.colStatus") }}</th>
          <th>{{ t("project.colPriority") }}</th>
          <th>{{ t("project.colSource") }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in rows" :key="item.id" :class="{ ghosty: item.ghost }">
          <td class="td-title">{{ titleOf(item) }}</td>
          <td>{{ statusName(item) }}</td>
          <td>
            <span v-if="priorityName(item) !== '—'" class="prio-chip" :data-p="priorityName(item)">
              {{ priorityName(item) }}
            </span>
            <span v-else>—</span>
          </td>
          <td class="td-src">{{ tagOf(item) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="rows.length === 0" class="tbl-empty">{{ t("project.noItems") }}</p>
  </div>
</template>

<style scoped>
.tbl-wrap {
  flex: 1;
  overflow: auto;
  padding: 10px;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th {
  text-align: left;
  color: var(--text-dim);
  font-weight: 600;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
}
td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
}
tr.ghosty td {
  opacity: 0.55;
}
.td-title {
  word-break: break-word;
}
.td-src {
  color: var(--text-dim);
}
.cell-select {
  font-size: 12px;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 4px;
}
.prio-chip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  background: var(--bg-selected);
  color: var(--accent);
}
.tbl-empty {
  text-align: center;
  color: var(--text-dim);
  font-size: 12px;
  padding: 24px 0;
}
</style>
