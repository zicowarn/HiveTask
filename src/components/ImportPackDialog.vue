<script setup lang="ts">
/**
 * 导入设备包对话框（《架构设计-导出与导入》§导入）：
 * 选文件 → 预览 → 按项目 uuid 三选一（预选系统建议）→ 应用。
 *
 * 安全默认：建议项由后端按 `updated_at` 比较给出（本机较新 → 保留；包较新 →
 * 覆盖），用户可逐项改。覆盖前 Rust 侧自动打操作级快照；应用全程单事务，
 * 失败整体回滚（不会有"导了一半"的中间态）。
 */
import { computed, ref, watch } from "vue";
import DropdownMenu from "./DropdownMenu.vue";
import { api, isTauri, type ImportAction, type ImportPreview } from "../api";
import { useI18n } from "../i18n";
import { reportError } from "../gh-errors";
import { pushToast } from "../toast";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; applied: [] }>();

const { t } = useI18n();

interface Row {
  preview: ImportPreview;
  action: ImportAction;
}

const rows = ref<Row[]>([]);
const packJson = ref<string | null>(null);
const packName = ref<string | null>(null);
const reading = ref(false);
const applying = ref(false);
const error = ref<string | null>(null);
/** 覆盖项的两击确认（沿用本仓库删除类动作的惯例）：第一击只上膛。 */
const armed = ref(false);

const canApply = computed(() => rows.value.length > 0 && !applying.value);
const summary = computed(() => {
  const counts: Record<ImportAction, number> = { add: 0, overwrite: 0, keep: 0 };
  for (const r of rows.value) counts[r.action] += 1;
  return counts;
});

/**
 * 每行的动作候选跟着该行的前提走：**本机没有 → 只能新增**；本机已有 →
 * 覆盖或保留。刻意不给"本机已有"的行留「新增」——uuid 命中时"新增"实际执行的
 * 是整项目替换，等于绕过覆盖的两击确认（同一动作两个名字，最容易手滑）。
 */
function actionOptions(row: ImportPreview) {
  if (!row.localUpdatedAt) return [{ value: "add", label: t("transfer.actionAdd") }];
  return [
    { value: "overwrite", label: t("transfer.actionOverwrite") },
    { value: "keep", label: t("transfer.actionKeep") },
  ];
}

function reset(): void {
  rows.value = [];
  packJson.value = null;
  packName.value = null;
  error.value = null;
  reading.value = false;
  applying.value = false;
  armed.value = false;
}

// 关闭即清空：下次打开是干净状态（上一次的选择不该残留）
watch(
  () => props.open,
  (open) => {
    if (!open) reset();
  },
);

/** 日期部分（后端给的是 `YYYY-MM-DDTHH:MM:SSZ` 的 UTC 串）。 */
function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

async function pickFile(): Promise<void> {
  if (!isTauri() || reading.value) return;
  error.value = null;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [{ name: t("transfer.packFilter"), extensions: ["export", "json"] }],
    });
    const path = typeof picked === "string" ? picked : null;
    if (!path) return;
    reading.value = true;
    const json = await api.readTextFile(path);
    const previews = await api.importPreview(json);
    packJson.value = json;
    packName.value = path.split("/").pop() ?? path;
    rows.value = previews.map((preview) => ({ preview, action: preview.suggestion }));
  } catch (e) {
    error.value = String(e);
    reportError(String(e));
  } finally {
    reading.value = false;
  }
}

async function apply(): Promise<void> {
  const json = packJson.value;
  if (!json || applying.value) return;
  // 有覆盖项时必须两击（第一击上膛，标签换成确认文案）：覆盖是本流程唯
  // 一会丢本机内容的动作，不能一次点击就发生（《导出与导入》§防重复误操作 2）
  if (summary.value.overwrite > 0 && !armed.value) {
    armed.value = true;
    return;
  }
  applying.value = true;
  error.value = null;
  try {
    const decisions: Record<string, ImportAction> = {};
    for (const r of rows.value) decisions[r.preview.id] = r.action;
    const [added, overwritten, kept] = await api.importApply(json, decisions);
    pushToast({
      kind: "success",
      message: t("transfer.applied", { added, overwritten, kept }),
    });
    emit("applied");
    emit("close");
  } catch (e) {
    error.value = String(e);
    reportError(String(e));
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="pack-overlay" @click.self="emit('close')">
    <div class="pack-panel" role="dialog" :aria-label="t('transfer.importTitle')">
      <div class="pack-head">
        <span class="pack-title">{{ t("transfer.importTitle") }}</span>
      </div>
      <p class="pack-desc">{{ t("transfer.importDesc") }}</p>

      <div class="pack-pick">
        <button class="pack-btn" :disabled="reading" @click="pickFile">
          {{ reading ? t("list.loading") : t("transfer.pickFile") }}
        </button>
        <span v-if="packName" class="pack-name">{{ packName }}</span>
      </div>

      <p v-if="rows.length === 0 && !packName" class="pack-empty">{{ t("transfer.noPreview") }}</p>

      <ul v-if="rows.length" class="pack-list">
        <li v-for="row in rows" :key="row.preview.id" class="pack-item">
          <span class="pack-item-name">{{ row.preview.name }}</span>
          <span class="pack-item-meta">
            {{ t("transfer.itemCount", { items: row.preview.items, fields: row.preview.fields }) }}
          </span>
          <span class="pack-item-meta">
            {{
              row.preview.localUpdatedAt
                ? t("transfer.compare", {
                    local: day(row.preview.localUpdatedAt),
                    pack: day(row.preview.packUpdatedAt),
                  })
                : t("transfer.absentLocal")
            }}
          </span>
          <DropdownMenu
            class="pack-item-action"
            :options="actionOptions(row.preview)"
            :model-value="row.action"
            @update:model-value="row.action = $event as ImportAction"
          />
        </li>
      </ul>

      <p v-if="rows.length" class="pack-hint">{{ t("transfer.overwriteHint") }}</p>
      <p v-if="error" class="pack-error">{{ error }}</p>

      <div class="pack-foot">
        <span v-if="rows.length" class="pack-summary">
          {{
            t("transfer.summary", {
              add: summary.add,
              overwrite: summary.overwrite,
              keep: summary.keep,
            })
          }}
        </span>
        <button class="pack-btn" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button
          class="pack-btn primary"
          :class="{ armed: armed && summary.overwrite > 0 }"
          :disabled="!canApply"
          @click="apply"
        >
          {{
            applying
              ? t("transfer.applying")
              : armed && summary.overwrite > 0
                ? t("transfer.confirmOverwrite", { n: summary.overwrite })
                : t("transfer.apply")
          }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pack-overlay {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.pack-panel {
  width: 640px;
  max-width: calc(100vw - 40px);
  max-height: 78vh;
  overflow: auto;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-panel);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
}
.pack-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pack-title {
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.pack-desc {
  margin: 6px 0 10px;
  font-size: var(--font-sm);
  color: var(--text-dim);
  line-height: 1.5;
}
.pack-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.pack-name {
  font-size: var(--font-sm);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pack-empty {
  margin: 10px 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.pack-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.pack-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
}
.pack-item-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-base);
  color: var(--text);
}
.pack-item-meta {
  flex: none;
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.pack-item-action {
  flex: none;
  width: 96px;
}
.pack-hint {
  margin: 8px 0 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.pack-error {
  margin: 8px 0 0;
  font-size: var(--font-sm);
  color: var(--danger);
}
.pack-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.pack-summary {
  margin-right: auto;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.pack-btn {
  height: 24px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  cursor: pointer;
}
.pack-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.pack-btn.primary {
  border-color: var(--accent);
  color: var(--accent);
}
/* 上膛态（覆盖前两击确认）：用危险色，让"再点一下就真覆盖了"看得见 */
.pack-btn.primary.armed {
  border-color: var(--danger);
  background: var(--danger);
  color: #fff;
}
.pack-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
