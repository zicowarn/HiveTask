/**
 * Open an external URL through the OS browser. Tauri windows use the
 * opener plugin; the plain-browser preview falls back to a new tab.
 */
export function openExternalUrl(url: string): void {
  if ("__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url));
  } else {
    window.open(url, "_blank", "noopener");
  }
}
