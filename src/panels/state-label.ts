/**
 * Human label for GitHub issue/PR state — both the entity form gh returns
 * ("OPEN" | "CLOSED" | "MERGED", shown on detail badges) and the lowercase
 * filter-tab values ("open" | "closed" | "merged" | "all"). Supersedes the
 * i18n round-1 decision to keep GitHub state terms in English: the detail
 * badges already translated merged/draft, so the rest followed.
 *
 * Lookup happens at call time — inside the template — so a language switch
 * re-renders (same contract as review-label.ts).
 */
import { t, type MessageKey } from "../i18n";

const STATE_KEYS: Record<string, MessageKey> = {
  OPEN: "state.open",
  open: "state.open",
  CLOSED: "state.closed",
  closed: "state.closed",
  MERGED: "state.merged",
  merged: "state.merged",
  all: "state.all",
};

export function stateLabel(state?: string | null): string {
  if (!state) return "";
  const key = STATE_KEYS[state];
  return key ? t(key) : state;
}
