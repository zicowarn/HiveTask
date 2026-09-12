/**
 * gh CLI error translation. Patterns are matched against the raw error
 * string (Rust wraps gh's stderr with "gh 退出码 …: " but the substring
 * survives), and each rule maps to an i18n key so messages follow the
 * locale. Unmatched errors fall through untranslated.
 *
 * Rules were captured from real failures, including two traps:
 * - git prints LOCALIZED stderr ("致命错误：不是 git 仓库") — match zh too;
 * - write permissions are per-operation on GitHub (commenting a public
 *   repo needs none, closing needs triage), so there is deliberately no
 *   up-front permission gate — errors are translated as they happen.
 */
import { t, type MessageKey } from "./i18n";
import { pushToast } from "./toast";

interface ErrorRule {
  pattern: RegExp;
  key: MessageKey;
}

const RULES: ErrorRule[] = [
  { pattern: /找不到 gh CLI/i, key: "app.ghMissing" },
  {
    pattern: /does not have the correct permissions|resource not accessible|must have admin|http 403|forbidden/i,
    key: "error.permission",
  },
  { pattern: /could not resolve to an? |not found/i, key: "error.notFound" },
  { pattern: /bad credentials|unauthorized|http 401/i, key: "error.auth" },
  { pattern: /rate limit/i, key: "error.rateLimit" },
  { pattern: /is locked/i, key: "error.locked" },
  {
    pattern: /不是 git 仓库|not a git repository|could not find repository|no git remotes|failed to run git|does not appear to be a git repository/i,
    key: "error.repo",
  },
  {
    pattern: /dial tcp|connection refused|no such host|lookup |i\/o timeout|http 5\d\d|tls|certificate|proxyconnect/i,
    key: "error.network",
  },
];

export function translateError(raw: string): string {
  for (const rule of RULES) {
    if (rule.pattern.test(raw)) return t(rule.key);
  }
  return raw;
}

/** The network rule, exported for reachability tracking: a failure that
 * matches it means GitHub is unreachable; anything else (auth, permission,
 * …) proves the connection itself works. */
const NETWORK_RULE = RULES.find((r) => r.key === "error.network")!;

export function isNetworkError(raw: string): boolean {
  return NETWORK_RULE.pattern.test(raw);
}

/** Translate + toast in one call — the standard mutation error path.
 * The raw output also lands in the app log (same moment as the toast),
 * so 8s-later toast expiry never means the evidence is gone.
 * `detail` is attached only when translation happened. */
export function reportError(raw: string): void {
  const message = translateError(raw);
  pushToast(
    message === raw ? { kind: "error", message } : { kind: "error", message, detail: raw },
  );
  // Dynamic import keeps @tauri-apps/api out of pure-logic unit tests.
  if ("__TAURI_INTERNALS__" in window) {
    void import("./api")
      .then((m) => m.api.logLine("error", raw))
      .catch(() => {});
  }
}
