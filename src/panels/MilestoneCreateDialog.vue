<script setup lang="ts">
/**
 * 里程碑创建对话框：名称/截止日/描述。创建走 Source 写穿透
 * （成功 toast + 里程碑元数据 store 强制重拉，组头/详情立即反映）。
 */
import { computed, ref, watch } from "vue";
import { api, isTauri } from "../api";
import { useIssuesStore } from "../stores/issues";
import { useRepoStore } from "../stores/repo";
import { useI18n } from "../i18n";
import { pushToast } from "../toast";
import { translateError } from "../gh-errors";
import MarkdownView from "../components/MarkdownView.vue";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const store = useIssuesStore();
const repoStore = useRepoStore();
const { t } = useI18n();

const name = ref("");
const due = ref("");
const desc = ref("");
// 描述是 Markdown（详情页经 MarkdownView 渲染），对齐 GitHub 写前可预览
const descTab = ref<"write" | "preview">("write");
const creating = ref(false);
const error = ref<string | null>(null);

const canSubmit = computed(() => !!name.value.trim() && !creating.value);

async function submit() {
  const repo = repoStore.current;
  if (!canSubmit.value || !repo) return;
  creating.value = true;
  error.value = null;
  try {
    await api.createMilestone(repo, name.value, due.value || undefined, desc.value || undefined);
    pushToast({ kind: "success", message: t("milestone.createdToast", { name: name.value }) });
    // 元数据强制重拉：组头与里程碑详情立即反映新里程碑
    if (isTauri()) void store.loadMilestones(repo, true);
    reset();
    emit("close");
  } catch (e) {
    error.value = translateError(String(e)); // 留在对话框，输入不丢
  } finally {
    creating.value = false;
  }
}

function reset() {
  name.value = "";
  due.value = "";
  desc.value = "";
  descTab.value = "write";
  error.value = null;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && !creating.value) emit("close");
}

watch(
  () => props.open,
  (open) => {
    if (open) reset();
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mc-overlay" @click.self="!creating && emit('close')" @keydown="onKeydown">
      <div class="mc-card" role="dialog" :aria-label="t('milestone.createTitle')">
        <div class="mc-head">
          <h3 class="mc-title">{{ t("milestone.createTitle") }}</h3>
          <button v-if="!creating" class="mc-close" @click="emit('close')">✕</button>
        </div>

        <p v-if="error" class="mc-error">{{ error }}</p>

        <input
          v-model="name"
          class="mc-input"
          :placeholder="t('milestone.namePh')"
          spellcheck="false"
        />
        <div class="mc-row">
          <label class="mc-label" for="mc-due">{{ t("milestone.dueLabel") }}</label>
          <input id="mc-due" v-model="due" type="date" class="mc-input mc-date" />
        </div>
        <div class="mc-tabs">
          <button
            class="mc-tab"
            :class="{ active: descTab === 'write' }"
            @click="descTab = 'write'"
          >{{ t("issue.tabWrite") }}</button>
          <button
            class="mc-tab"
            :class="{ active: descTab === 'preview' }"
            @click="descTab = 'preview'"
          >{{ t("issue.tabPreview") }}</button>
        </div>
        <textarea
          v-if="descTab === 'write'"
          v-model="desc"
          class="mc-textarea"
          :placeholder="t('milestone.descPh')"
          rows="5"
        />
        <div v-else class="mc-preview">
          <MarkdownView v-if="desc.trim()" :source="desc" />
          <p v-else class="mc-preview-empty">{{ t("common.noBody") }}</p>
        </div>

        <p class="mc-hint">{{ t("milestone.createHint") }}</p>

        <div class="mc-actions">
          <button class="mc-btn" :disabled="creating" @click="emit('close')">{{ t("conn.cancel") }}</button>
          <button class="mc-btn primary" :disabled="!canSubmit" @click="submit">
            {{ creating ? t("common.syncing") : t("issue.submit") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mc-overlay {
  position: fixed;
  inset: 0;
  z-index: 230;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.mc-card {
  width: 460px;
  max-width: calc(100vw - 40px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 14px 16px;
}
.mc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.mc-title {
  margin: 0;
  font-size: var(--font-base);
  color: var(--text);
}
.mc-close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.mc-close:hover {
  color: var(--text);
}
.mc-error {
  margin: 0;
  padding: 7px 10px;
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
  word-break: break-all;
}
.mc-input,
.mc-textarea {
  box-sizing: border-box;
  width: 100%;
  font-size: var(--font-md);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 6px 8px;
  outline: none;
  resize: vertical;
}
/* 描述撰写/预览 Tab（与 Issue 创建对话框同构） */
.mc-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}
.mc-tab {
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  padding: 4px 10px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.mc-tab:hover {
  color: var(--text);
}
.mc-tab.active {
  color: var(--text);
  font-weight: 600;
  border-bottom-color: var(--accent);
}
.mc-preview {
  box-sizing: border-box;
  min-height: 90px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  padding: 8px 10px;
}
.mc-preview-empty {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.mc-input:focus,
.mc-textarea:focus {
  border-color: var(--accent);
}
.mc-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mc-label {
  flex: none;
  font-size: var(--font-md);
  color: var(--text-dim);
}
.mc-hint {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.mc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.mc-btn {
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  height: 26px;
  padding: 0 12px;
  border-radius: 6px;
  cursor: pointer;
}
.mc-btn.primary {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.mc-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
