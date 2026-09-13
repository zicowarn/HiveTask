<script setup lang="ts">
/**
 * GitHub 认证对话框（OAuth Device Flow）：展示用户码 → 打开授权页 →
 * 后台轮询令牌 → 喂入 gh 凭据库。凭据全程由 gh 托管，本应用不经手。
 */
import { ref, watch } from "vue";
import { api, isTauri } from "../api";
import { openExternalUrl } from "../open-url";
import { pushToast } from "../toast";
import { useI18n } from "../i18n";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; success: [login: string] }>();

const { t } = useI18n();

type Phase = "starting" | "waiting" | "success" | "failed";
const phase = ref<Phase>("starting");
const userCode = ref("");
const verificationUri = ref("https://github.com/login/device");
const failure = ref<string | null>(null);
const login = ref<string | null>(null);
let runId = 0;

async function start() {
  if (!isTauri()) return;
  phase.value = "starting";
  failure.value = null;
  const run = ++runId;
  try {
    const started = await api.ghDeviceFlowStart();
    if (run !== runId) return;
    userCode.value = started.userCode;
    verificationUri.value = started.verificationUri;
    phase.value = "waiting";
    void poll(started.deviceCode, started.intervalSecs, run);
  } catch (e) {
    if (run !== runId) return;
    failure.value = String(e);
    phase.value = "failed";
  }
}

async function poll(deviceCode: string, intervalSecs: number, run: number) {
  try {
    const token = await api.ghDeviceFlowPoll(deviceCode, intervalSecs);
    if (run !== runId) return;
    const who = await api.ghAuthWithToken(token);
    if (run !== runId) return;
    login.value = who;
    phase.value = "success";
    pushToast({ kind: "success", message: t("githubAuth.successToast", { name: who }) });
    emit("success", who);
  } catch (e) {
    if (run !== runId) return;
    failure.value = String(e);
    phase.value = "failed";
  }
}

async function copyCode() {
  await navigator.clipboard.writeText(userCode.value);
  pushToast({ kind: "success", message: t("githubAuth.copied") });
}

function openPage() {
  openExternalUrl(verificationUri.value);
}

function retry() {
  void start();
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      login.value = null;
      void start();
    } else {
      runId += 1; // 取消在途轮询
    }
  },
);

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && phase.value !== "waiting") emit("close");
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="gha-overlay" @click.self="phase !== 'waiting' && emit('close')" @keydown="onKeydown">
      <div class="gha-card" role="dialog" :aria-label="t('githubAuth.title')">
        <div class="gha-head">
          <h3 class="gha-title">{{ t("githubAuth.title") }}</h3>
          <button v-if="phase !== 'waiting'" class="gha-close" @click="emit('close')">✕</button>
        </div>

        <p class="gha-desc">{{ t("githubAuth.desc") }}</p>

        <div v-if="phase === 'starting'" class="gha-waiting">{{ t("list.loading") }}</div>

        <template v-if="phase === 'waiting'">
          <div class="gha-code-row">
            <code class="gha-code">{{ userCode }}</code>
            <button class="gha-btn" @click="copyCode">{{ t("githubAuth.copy") }}</button>
          </div>
          <button
            class="gha-btn primary"
            @click="openPage"
          >{{ t("githubAuth.openPage") }}</button>
          <p class="gha-waiting">{{ t("githubAuth.waiting") }}</p>
        </template>

        <template v-else-if="phase === 'success'">
          <div class="gha-code-row">
            <code class="gha-code done">{{ userCode }}</code>
          </div>
          <p class="gha-banner ok">✓ {{ t("githubAuth.successAs", { name: login ?? "" }) }}</p>
          <div class="gha-actions">
            <button class="gha-btn primary" @click="emit('close')">{{ t("about.close") }}</button>
          </div>
        </template>

        <template v-else>
          <p class="gha-banner error">{{ failure ?? t("githubAuth.failed") }}</p>
          <div class="gha-actions">
            <button class="gha-btn" @click="retry">{{ t("githubAuth.retry") }}</button>
            <button class="gha-btn" @click="emit('close')">{{ t("merge.cancel") }}</button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.gha-overlay {
  position: fixed;
  inset: 0;
  z-index: 240;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.gha-card {
  width: 380px;
  max-width: calc(100vw - 40px);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 14px 16px;
}
.gha-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.gha-title {
  margin: 0;
  font-size: 13px;
  color: var(--text);
}
.gha-close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.gha-close:hover {
  color: var(--text);
}
.gha-desc {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-dim);
}
.gha-code-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.gha-code {
  flex: 1;
  text-align: center;
  font-family: ui-monospace, monospace;
  font-size: 20px;
  letter-spacing: 3px;
  padding: 8px 0;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
}
.gha-code.done {
  text-decoration: line-through;
  color: var(--text-dim);
}
.gha-btn {
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  font-size: 12px;
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.gha-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.gha-btn.primary {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
.gha-waiting {
  font-size: 12px;
  color: var(--text-dim);
}
.gha-banner {
  padding: 8px 10px;
  font-size: 12px;
  border-radius: 6px;
  margin: 0 0 10px;
}
.gha-banner.ok {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 12%, transparent);
  border: 1px solid var(--success);
}
.gha-banner.error {
  color: var(--danger);
  background: var(--danger-banner);
  border: 1px solid var(--danger-banner-border);
  word-break: break-all;
}
.gha-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
