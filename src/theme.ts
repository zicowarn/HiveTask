/**
 * Theme switching, mirroring src/i18n's shape: a module-level ref plus
 * useTheme() for components.
 *
 * Applies `data-theme` on <html>, which styles.css keys the light palette
 * off; the :root dark palette doubles as the pre-JS fallback, so a failed
 * script load simply keeps today's dark look.
 *
 * Reactivity note: the palette swap itself is pure CSS, so components never
 * need to re-render on change — `theme` matters only for the toggle button's
 * label and tooltip.
 */
import { ref } from "vue";

export type Theme = "dark" | "light";

const STORAGE_KEY = "hivetask.theme";

/** Saved choice wins; otherwise follow the OS appearance, dark as fallback. */
function detectTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // Storage unavailable — fall through to OS appearance.
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export const theme = ref<Theme>(detectTheme());

function applyTheme(value: Theme): void {
  document.documentElement.dataset.theme = value;
}

/** Sync the <html> attribute once at startup, before first paint. */
export function initTheme(): void {
  applyTheme(theme.value);
}

export function setTheme(next: Theme): void {
  theme.value = next;
  applyTheme(next);
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable — the choice still applies for this session.
  }
}

export function toggleTheme(): void {
  setTheme(theme.value === "dark" ? "light" : "dark");
}

export function useTheme() {
  return { theme, setTheme, toggleTheme };
}
