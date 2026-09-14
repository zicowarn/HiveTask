<script setup lang="ts">
/**
 * PR 创建对话框（远端来源）：head/base 从远端分支清单选择，
 * 创建走 Source 写穿透——成功后列表刷新并选中新 PR。
 */
import { computed, ref, watch } from "vue";
import { api, isTauri } from "../api";
import { useI18n } from "../i18n";

const props = defineProps<{ open: boolean; repoPath: string }>();
const emit = defineEmits<{ close: []; created: [number: number] }>();

const { t } = useI18n();

const heads = ref<string[]>([]);
const bases = ref<string[]>([]);
const head = ref("");
const base = ref("");
const title = ref("");
const body = ref("");
const loading = ref(false);
const creating = ref(false);
const error = ref<string | null>(null);

const canSubmit = computed(() => head.value && base.value && title.value.trim() && !creating.value);

async function loadBranches() {
  if (!isTauri() || !props.repoPath) return;
  loading.value = true;
  error.value = null;
  try {
    const names = await api.remoteBranchList(props.repoPath);
    heads.value = names;
    bases.value = names;
    base.value = names.find((n) => n === "main") ?? names.find((n) => n === "master") ?? names[0] ?? "";
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!canSubmit.value) return;
  creating.value = true;
  error.value = null;
  try {
    const created = await api.createPull(props.repoPath, head.value, base.value, title.value.trim(), body.value || undefined);
    emit("created", created.number);
    reset();
  } catch (e) {
    error.value = String(e);
  } finally {
    creating.value = false;
  }
}

function reset() {
  title.value = "";
  body.value = "";
  head.value = "";
  base.value = "";
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && !creating.value) emit("close");
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      reset();
      error.value = null;
      void loadBranches();
    }
  },
);

</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="pc-overlay" @click.self="!creating && emit('close')" @keydown="onKeydown">
      <div class="pc-card" role="dialog" :aria-label="t('pull.createBtn')">
        <div class="pc-head">
          <h3 class="pc-title">{{ t("pull.createTitle") }}</h3>
          <button v-if="!creating" class="pc-close" @click="emit('close')">✕</button>
        </div>

        <p v-if="error" class="pc-error">{{ error }}</p>

        <div class="pc-row">
          <span class="pc-label">{{ t("branchReview.base") }}</span>
          <select v-model="base" class="pc-select" :disabled="loading">
            <option v-for="n in bases" :key="n" :value="n">{{ n }}</option>
          </select>
        </div>
        <div class="pc-row">
          <span class="pc-label">{{ t("pull.headLabel") }}</span>
          <select v-model="head" class="pc-select" :disabled="loading">
            <option v-for="h in heads.filter((x) => x !== base)" :key="h" :value="h">{{ h }}</option>
          </select>
        </div>
        <input
          v-model="title"
          class="pc-input"
          :placeholder="t('issue.titlePlaceholder')"
          spellcheck="false"
        />
        <textarea
          v-model="body"
          class="pc-textarea"
          :placeholder="t('issue.bodyPlaceholder')"
          rows="3"
        />

        <div class="pc-actions">
          <button class="pc-btn" :disabled="creating" @click="emit('close')">{{ t("conn.cancel") }}</button>
          <button class="pc-btn primary" :disabled="!canSubmit" @click="submit">
            {{ creating ? t("common.syncing") : t("issue.submit") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.pc-overlay {
  position: fixed;
  inset: 0;
  z-index: 230;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.pc-card {
  width: 420px;
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
.pc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pc-title {
  margin: 0;
  font-size: var(--font-base);
  color: var(--text);
}
.pc-close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.pc-close:hover {
  color: var(--text);
}
.pc-error {
  margin: 0;
  padding: 7px 10px;
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  border-radius: 6px;
  word-break: break-all;
}
.pc-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pc-label {
  width: 72px;
  flex: none;
  font-size: var(--font-md);
  color: var(--text-dim);
}
.pc-select {
  flex: 1;
  font-size: var(--font-md);
  color: var(--text);
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 4px 6px;
}
.pc-input,
.pc-textarea {
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
.pc-input:focus,
.pc-textarea:focus {
  border-color: var(--accent);
}
.pc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.pc-btn {
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  height: 26px;
  padding: 0 12px;
  border-radius: 6px;
  cursor: pointer;
}
.pc-btn.primary {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.pc-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
