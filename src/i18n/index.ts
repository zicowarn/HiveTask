/**
 * Minimal i18n for a small, fixed message set.
 *
 * Deliberately dependency-free: ~40 messages across two locales needing only
 * `{placeholder}` interpolation — far less than vue-i18n's plurals/date
 * formatting would justify. Swapping in vue-i18n later only means replacing
 * this module, since components reach it through `useI18n()`.
 *
 * Reactivity: `t()` reads `locale.value` on every call, so any template that
 * calls it re-renders when the locale changes. Never cache `t()` results in a
 * module-level or setup-level constant — that would freeze the old language.
 */
import { ref } from "vue";
import { zhCN, type MessageKey } from "./zh-CN";
import { enUS } from "./en-US";

export type { MessageKey };

export type Locale = "zh-CN" | "en-US";

const STORAGE_KEY = "hivetask.locale";

export const locales: { value: Locale; label: string }[] = [
  { value: "zh-CN", label: "中文" },
  { value: "en-US", label: "English" },
];

const catalogs: Record<Locale, Record<MessageKey, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

/** Saved choice wins; otherwise follow the system language. */
function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh-CN" || saved === "en-US") return saved;
  } catch {
    // Storage unavailable — fall through to system detection.
  }
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export const locale = ref<Locale>(detectLocale());

export function setLocale(next: Locale): void {
  locale.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable — the choice still applies for this session.
  }
}

export function toggleLocale(): void {
  setLocale(locale.value === "zh-CN" ? "en-US" : "zh-CN");
}

/** Cycle through `locales` in order, wrapping around (statusbar cell). */
export function cycleLocale(): void {
  const index = locales.findIndex((l) => l.value === locale.value);
  setLocale(locales[(index + 1) % locales.length].value);
}

export type TranslateParams = Record<string, string | number>;

/** Translate a key, substituting `{name}` placeholders. */
export function t(key: MessageKey, params?: TranslateParams): string {
  const table = catalogs[locale.value] ?? catalogs["zh-CN"];
  let message: string = table[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      message = message.replaceAll(`{${name}}`, String(value));
    }
  }
  return message;
}

export function useI18n() {
  return { t, locale, setLocale, toggleLocale, cycleLocale, locales };
}
