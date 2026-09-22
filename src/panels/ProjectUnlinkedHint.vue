<script setup lang="ts">
/**
 * 未关联条目提示条——设备包导入时仓库未命中（或登记行被删）的引用条目在这里收口。
 *
 * 为什么要这一条：那些条目此前**看着像正常卡、点开是空的**（repo_id 为 NULL 但
 * 判定算不上悬挂），且 origin 被丢弃，修不回来。现在 origin 快照落库（app_016），
 * 这里给出「有几个 / 来源是谁 / 一键挂回」，挂不回去时也如实留着（不假装修好）。
 *
 * 自持 store（计数 / 来源 / 回填动作都在这里），宿主只管摆位置——
 * 三个视图（Board / Table / Roadmap）共用，因为未关联与视图无关。
 */
import { computed, ref } from "vue";
import { useI18n } from "../i18n";
import { useProjectsStore } from "../stores/projects";
import { translateError } from "../gh-errors";
import { pushToast } from "../toast";

const { t } = useI18n();
const store = useProjectsStore();

const unlinked = computed(() => store.items.filter((i) => i.ghost));
/** 来源清单（去重；没有快照的老条目诚实说"来源未知"）。 */
const origins = computed(() => {
  const seen = new Set<string>();
  for (const it of unlinked.value) seen.add(it.originUrl ?? t("project.unlinkedUnknown"));
  return [...seen].join("、");
});

const relinking = ref(false);

async function relink(): Promise<void> {
  if (relinking.value) return;
  relinking.value = true;
  try {
    const n = await store.relinkOrigin();
    pushToast(
      n > 0
        ? { kind: "success", message: t("project.relinkDone", { n }) }
        : { kind: "info", message: t("project.relinkNone") },
    );
  } catch (e) {
    pushToast({ kind: "error", message: translateError(String(e)) });
  } finally {
    relinking.value = false;
  }
}
</script>

<template>
  <div v-if="unlinked.length" class="pj-unlinked">
    <span class="pj-unlinked-text">
      {{ t("project.unlinkedHint", { n: unlinked.length, origins }) }}
    </span>
    <button class="pj-unlinked-btn" :disabled="relinking" @click="relink">
      {{ relinking ? t("common.syncing") : t("project.relink") }}
    </button>
  </div>
</template>

<style scoped>
.pj-unlinked {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel);
}
.pj-unlinked-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.pj-unlinked-btn {
  flex: none;
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel);
  color: var(--text);
  font-size: var(--font-md);
  cursor: pointer;
}
.pj-unlinked-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.pj-unlinked-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
