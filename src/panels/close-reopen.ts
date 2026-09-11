/**
 * Two-step close confirmation shared by the detail panels: closing fires
 * only on the second click (within 3s), reopening fires immediately —
 * reopen is cheap to undo, close hides work from the default view.
 * `working` spans the in-flight mutation for both directions.
 */
import { onBeforeUnmount, ref } from "vue";

export function useCloseReopen(run: (closed: boolean) => Promise<void>) {
  const armed = ref(false);
  const working = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function close(): Promise<void> {
    if (working.value) return;
    if (!armed.value) {
      armed.value = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => (armed.value = false), 3000);
      return;
    }
    if (timer) clearTimeout(timer);
    armed.value = false;
    working.value = true;
    try {
      await run(true);
    } finally {
      working.value = false;
    }
  }

  async function reopen(): Promise<void> {
    if (working.value) return;
    working.value = true;
    try {
      await run(false);
    } finally {
      working.value = false;
    }
  }

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
  });

  return { armed, working, close, reopen };
}
