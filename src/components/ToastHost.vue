<script setup lang="ts">
/**
 * ToastHost — the single renderer for src/toast.ts's queue, mounted once
 * in App.vue above the status bar (bottom-right). Errors need manual
 * acknowledgement is NOT enforced: they auto-dismiss after 8s like the
 * rest, but carry the raw gh output as an expandable detail line.
 */
import { toasts, dismissToast } from "../toast";

const kindIcon: Record<string, string> = {
  error: "✕",
  info: "ℹ",
  success: "✓",
};
</script>

<template>
  <Teleport to="body">
    <div class="toast-region" aria-live="polite">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast"
          :class="toast.kind"
          role="alert"
        >
          <span class="toast-icon">{{ kindIcon[toast.kind] ?? "ℹ" }}</span>
          <div class="toast-body">
            <p class="toast-message">{{ toast.message }}</p>
            <p v-if="toast.detail" class="toast-detail" :title="toast.detail">
              {{ toast.detail }}
            </p>
          </div>
          <button class="toast-close" :aria-label="'关闭'" @click="dismissToast(toast.id)">✕</button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-region {
  position: fixed;
  right: 12px;
  bottom: 32px; /* clears the 24px status bar */
  z-index: 300; /* above the About dialog overlay (200) */
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 360px;
  max-width: calc(100vw - 24px);
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 10px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--text-dim);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
  font-size: var(--font-md);
}
.toast.error {
  border-left-color: var(--danger);
}
.toast.info {
  border-left-color: var(--accent);
}
.toast.success {
  border-left-color: var(--success);
}
.toast-icon {
  flex: none;
  font-size: var(--font-sm);
  line-height: 1.5;
  color: var(--text-dim);
}
.toast.error .toast-icon {
  color: var(--danger);
}
.toast.info .toast-icon {
  color: var(--accent);
}
.toast.success .toast-icon {
  color: var(--success);
}
.toast-body {
  flex: 1;
  min-width: 0;
}
.toast-message {
  margin: 0;
  color: var(--text);
  line-height: 1.5;
}
.toast-detail {
  margin: 4px 0 0;
  font-size: var(--font-sm);
  line-height: 1.4;
  color: var(--text-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  user-select: text;
}
.toast-close {
  flex: none;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-sm);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}
.toast-close:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.22s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
