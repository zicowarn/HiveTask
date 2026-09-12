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
/** 用户可选项：两种语言 + 跟随系统。localStorage 里存的是 LocaleChoice。 */
export type LocaleChoice = Locale | "system";

const STORAGE_KEY = "hivetask.locale";

export const locales: { value: Locale; label: string }[] = [
  { value: "zh-CN", label: "中文" },
  { value: "en-US", label: "English" },
];

const catalogs: Record<Locale, Record<MessageKey, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
};

/** Saved choice wins; "system" (or legacy default) follows the OS language. */
function detectLocaleChoice(): LocaleChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh-CN" || saved === "en-US" || saved === "system") return saved;
  } catch {
    // Storage unavailable — fall through to system detection.
  }
  return "system";
}

/** The OS language, re-read so "system" tracks `languagechange` live. */
function systemLocale(): Locale {
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

/** The user's raw choice — statusbar cell and settings select bind this. */
export const localeChoice = ref<LocaleChoice>(detectLocaleChoice());
/** What t() actually renders. */
export const locale = ref<Locale>(
  localeChoice.value === "system" ? systemLocale() : localeChoice.value,
);

if (typeof window !== "undefined") {
  window.addEventListener("languagechange", () => {
    if (localeChoice.value === "system") locale.value = systemLocale();
  });
}

export function setLocale(next: LocaleChoice): void {
  localeChoice.value = next;
  locale.value = next === "system" ? systemLocale() : next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage unavailable — the choice still applies for this session.
  }
}

/** Cycle through `choices` in order, wrapping around (statusbar cell). */
export function cycleLocale(): void {
  const choices: LocaleChoice[] = ["zh-CN", "en-US", "system"];
  const index = choices.indexOf(localeChoice.value);
  setLocale(choices[(index + 1) % choices.length]);
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
  return { t, locale, localeChoice, setLocale, cycleLocale, locales };
}
