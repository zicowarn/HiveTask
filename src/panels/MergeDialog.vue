<script setup lang="ts">
/**
 * Merge confirmation dialog — merge is irreversible, so the detail
 * panel's Merge button opens this instead of firing directly. Pick one
 * of GitHub's three methods (defaults to a plain merge commit), confirm
 * or cancel; Esc / overlay click cancels like the About dialog.
 */
import { ref, watch } from "vue";
import { useI18n } from "../i18n";

const props = defineProps<{ open: boolean; working: boolean }>();
const emit = defineEmits<{ confirm: [method: "merge" | "squash" | "rebase"]; cancel: [] }>();

const { t } = useI18n();

const method = ref<"merge" | "squash" | "rebase">("merge");

// Each open starts fresh on the conventional default.
watch(
  () => props.open,
  (open) => {
    if (open) method.value = "merge";
  },
);

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("cancel");
}

const options: { value: "merge" | "squash" | "rebase"; labelKey: "merge.merge" | "merge.squash" | "merge.rebase"; descKey: "merge.mergeDesc" | "merge.squashDesc" | "merge.rebaseDesc" }[] = [
  { value: "merge", labelKey: "merge.merge", descKey: "merge.mergeDesc" },
  { value: "squash", labelKey: "merge.squash", descKey: "merge.squashDesc" },
  { value: "rebase", labelKey: "merge.rebase", descKey: "merge.rebaseDesc" },
];
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="merge-overlay" @click.self="emit('cancel')" @keydown="onKeydown">
      <div class="merge-card" role="dialog" :aria-label="t('merge.title')">
        <h3 class="merge-title">{{ t("merge.title") }}</h3>

        <label v-for="opt in options" :key="opt.value" class="merge-option">
          <input v-model="method" class="merge-radio" type="radio" name="merge-method" :value="opt.value" />
          <span class="option-text">
            <span class="option-label">{{ t(opt.labelKey) }}</span>
            <span class="option-desc">{{ t(opt.descKey) }}</span>
          </span>
        </label>

        <p class="merge-hint">{{ t("merge.hint") }}</p>

        <div class="merge-actions">
          <button class="dialog-btn" :disabled="working" @click="emit('cancel')">
            {{ t("merge.cancel") }}
          </button>
          <button
            class="dialog-btn primary"
            :disabled="working"
            @click="emit('confirm', method)"
          >
            {{ working ? t("merge.working") : t("merge.confirm") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.merge-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.merge-card {
  width: 420px;
  max-width: calc(100vw - 40px);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 20px 22px 16px;
}
.merge-title {
  margin: 0 0 14px;
  font-size: var(--font-lg);
  font-weight: 700;
  color: var(--text);
}
.merge-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  margin-bottom: 8px;
  cursor: pointer;
}
.merge-option:hover {
  background: var(--bg-hover);
}
.merge-radio {
  margin-top: 2px;
  accent-color: var(--accent);
}
.option-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.option-label {
  font-size: var(--font-base);
  color: var(--text);
}
.option-desc {
  font-size: var(--font-sm);
  color: var(--text-dim);
  line-height: 1.5;
}
.merge-hint {
  margin: 12px 0 0;
  font-size: var(--font-sm);
  color: var(--warning);
}
.merge-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.dialog-btn {
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  height: 26px;
  padding: 0 16px;
  border-radius: 6px;
  cursor: pointer;
}
.dialog-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.dialog-btn.primary {
  background: var(--bg-selected);
  color: var(--accent);
  border-color: var(--accent);
  font-weight: 600;
}
.dialog-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
