/**
 * Human label for a GitHub `reviewDecision` enum value.
 *
 * Shared by the PR list and PR detail panels (previously duplicated as a
 * `decisionLabel` record in both). The lookup happens at call time — inside
 * the template — so a language switch re-renders; a record built during
 * setup would freeze the locale that was active then.
 */
import { t, type MessageKey } from "../i18n";

const REVIEW_KEYS: Record<string, MessageKey> = {
  APPROVED: "review.approved",
  REVIEW_REQUIRED: "review.reviewRequired",
  CHANGES_REQUESTED: "review.changesRequested",
};

export function reviewLabel(decision?: string | null): string {
  if (!decision) return "";
  const key = REVIEW_KEYS[decision];
  return key ? t(key) : decision;
}
