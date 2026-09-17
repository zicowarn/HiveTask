<script setup lang="ts">
/**
 * 新建文件 / 文件夹（VS Code 侧栏头部两个按钮的落点）。
 * 名称输入 → `kb_create` → 刷新父目录并选中新条目；同名会被后端拒绝（不覆盖）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useI18n } from "../i18n";
import { useKnowledgeStore } from "../stores/knowledge";

const props = defineProps<{
  kind: "file" | "dir";
  /** 显式父目录（右键菜单"在此目录新建"）；缺省按当前选中推断。 */
  parent?: string;
}>();
const emit = defineEmits<{ close: [] }>();

const store = useKnowledgeStore();
const { t } = useI18n();

const name = ref(props.kind === "file" ? "untitled.md" : "新建文件夹");
const parentLabel = computed(() => props.parent || store.createParent || store.rootName || t("kb.rootLabel"));
const input = ref<HTMLInputElement | null>(null);
const error = ref<string | null>(null);
const working = ref(false);

onMounted(() => {
  void nextTick(() => {
    input.value?.focus();
    input.value?.select();
  });
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

async function submit(): Promise<void> {
  if (working.value) return;
  const value = name.value.trim();
  if (!value) {
    error.value = t("kb.nameRequired");
    return;
  }
  if (value.includes("/") || value.includes("\\")) {
    error.value = t("kb.nameInvalid");
    return;
  }
  working.value = true;
  try {
    await store.createEntry(props.kind, value, props.parent);
    emit("close");
  } catch (e) {
    error.value = String(e);
  } finally {
    working.value = false;
  }
}
</script>

<template>
  <div class="kb-overlay" @click.self="emit('close')">
    <div class="kb-panel" role="dialog" aria-modal="true">
      <header class="kb-head">
        <span class="kb-title">{{ kind === "file" ? t("kb.newFile") : t("kb.newFolder") }}</span>
        <button class="kb-close" :title="t('common.close')" @click="emit('close')">
          <EditorIcon name="o.x" />
        </button>
      </header>

      <p class="kb-where">
        <EditorIcon name="o.file-directory-fill" />
        <span class="kb-where-path">{{ parentLabel }}</span>
      </p>

      <input
        ref="input"
        v-model="name"
        class="kb-input"
        :placeholder="kind === 'file' ? t('kb.fileNamePlaceholder') : t('kb.folderNamePlaceholder')"
        @keydown.enter="submit"
      />

      <p v-if="error" class="kb-error">{{ error }}</p>

      <footer class="kb-foot">
        <button class="text-btn" @click="emit('close')">{{ t("common.close") }}</button>
        <button class="text-btn primary" :disabled="working" @click="submit">
          {{ t("kb.create") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.kb-overlay {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 18vh;
  background: rgba(0, 0, 0, 0.35);
}
.kb-panel {
  width: 380px;
  max-width: calc(100vw - 40px);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 12px 14px 12px;
}
.kb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
}
.kb-title {
  font-size: var(--font-base);
  font-weight: 700;
  color: var(--text);
}
.kb-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.kb-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.kb-where {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.kb-where-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-input {
  width: 100%;
  height: 30px;
  padding: 0 9px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  outline: none;
}
.kb-input:focus {
  border-color: var(--accent);
}
.kb-error {
  margin: 8px 0 0;
  font-size: var(--font-sm);
  color: var(--danger);
}
.kb-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.text-btn {
  height: 26px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  white-space: nowrap;
  cursor: pointer;
}
.text-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.text-btn.primary {
  background: var(--btn-primary);
  border-color: var(--btn-primary-border);
  color: #fff;
}
.text-btn.primary:hover {
  background: var(--btn-primary-hover);
  color: #fff;
}
.text-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
