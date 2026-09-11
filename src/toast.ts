/**
 * Global toast queue — module-level ref, the same pattern as src/i18n and
 * src/theme.ts: actions anywhere push, the single ToastHost in App.vue
 * renders. Errors carry the raw untranslated source as `detail` so the
 * translated message never loses the troubleshooting information.
 */
import { ref } from "vue";

export interface Toast {
  id: number;
  kind: "error" | "info" | "success";
  message: string;
  detail?: string;
}

export const toasts = ref<Toast[]>([]);
let nextId = 1;

export function pushToast(toast: Omit<Toast, "id">, ttlMs = 8000): number {
  const id = nextId++;
  toasts.value.push({ ...toast, id });
  if (ttlMs > 0) {
    setTimeout(() => dismissToast(id), ttlMs);
  }
  return id;
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}
