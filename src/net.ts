/**
 * GitHub reachability, tracked passively — never probed on a timer. The
 * startup health check seeds the first value; every gh roundtrip through
 * the stores updates it: success means online, and a *network-classified*
 * failure means offline (a permission rejection proves the network is
 * fine). null = unknown (plain-browser preview).
 */
import { ref } from "vue";
import { api, isTauri } from "./api";
import { isNetworkError } from "./gh-errors";

export const netOnline = ref<boolean | null>(null);

export function setOnline(value: boolean): void {
  netOnline.value = value;
}

/** User-initiated probe (status-bar cell click); seed value at startup. */
export async function probeNow(): Promise<void> {
  if (!isTauri()) return;
  try {
    await api.probeNetwork();
    netOnline.value = true;
  } catch (e) {
    // An auth failure still proves the network path works.
    netOnline.value = !isNetworkError(String(e));
  }
}
