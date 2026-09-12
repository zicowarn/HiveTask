/**
 * Theme switching, mirroring src/i18n's shape: a module-level ref plus
 * useTheme() for components.
 *
 * A choice of "system" follows the OS appearance live (matchMedia listener);
 * explicit "dark"/"light" pin the palette. The choice applies to <html> as
 * `data-theme`, which styles.css keys the palette off; the :root dark
 * palette doubles as the pre-JS fallback, so a failed script load simply
 * keeps today's dark look.
 *
 * Reactivity note: the palette swap itself is pure CSS, so components never
 * need to re-render on change — the refs matter only for the toggle button
 * label and the settings panel's select.
 */
import { ref } from "vue";

export type ThemeChoice = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "hivetask.theme";

const prefersLight = (): boolean =>
  window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;

/** Saved choice wins; otherwise follow the OS appearance. */
function detectTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light" || saved === "system") return saved;
  } catch {
    // Storage unavailable — fall through to OS appearance.
  }
  return "system";
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  if (choice === "system") return prefersLight() ? "light" : "dark";
  return choice;
}

export const theme = ref<ThemeChoice>(detectTheme());
const resolvedTheme = ref<ResolvedTheme>(resolve(theme.value));

function applyTheme(): void {
  document.documentElement.dataset.theme = resolvedTheme.value;
}

// Live-switch while following the OS and it changes underneath us.
window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change", () => {
  if (theme.value !== "system") return;
  resolvedTheme.value = resolve("system");
  applyTheme();
});

/** Sync the <html> attribute once at startup, before first paint. */
export function initTheme(): void {
  applyTheme();
}

export function setTheme(choice: ThemeChoice): void {
  theme.value = choice;
  resolvedTheme.value = resolve(choice);
  applyTheme();
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Storage unavailable — the choice still applies for this session.
  }
}

/** Cycle dark → light → system → dark (header button). */
export function cycleTheme(): void {
  const order: ThemeChoice[] = ["dark", "light", "system"];
  setTheme(order[(order.indexOf(theme.value) + 1) % order.length]);
}

export function useTheme() {
  return { theme, resolvedTheme, setTheme, cycleTheme };
}
