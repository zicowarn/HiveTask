<script setup lang="ts">
/**
 * 来源连接管理对话框——连接是命名实体（platform + host + 凭据引用），
 * 仓库通过 connection_id 关联；路由按连接的 platform 分发（user_set
 * 最高优先级）。GitHub 类连接的凭据由 gh CLI 管理，不存钥匙串。
 */
import { computed, onMounted, ref } from "vue";
import EditorIcon from "./EditorIcon.vue";
import { api, isTauri } from "../api";
import { useI18n } from "../i18n";
import { reportError } from "../gh-errors";
import { pushToast } from "../toast";

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

interface ConnectionEntry {
  id: string;
  platform: string;
  host: string;
  label: string;
  sourceState: string;
  createdAt: string;
}

const connections = ref<ConnectionEntry[]>([]);
const editing = ref(false);
const editId = ref<string | null>(null);
const form = ref({ platform: "gitea", host: "", label: "" });
const tokenInput = ref("");
const tokenSet = ref<boolean | null>(null);

const PLATFORMS: { value: string; label: string; ghManaged?: boolean }[] = [
  { value: "github", label: "GitHub", ghManaged: true },
  { value: "gitea", label: "Gitea" },
  { value: "gitee", label: "Gitee" },
  { value: "gitlab", label: "GitLab" },
];

const ghManaged = computed(() => form.value.platform === "github");

async function load() {
  if (!isTauri()) return;
  connections.value = await api.connectionList();
}

async function probeToken() {
  if (!isTauri() || ghManaged.value) return;
  try {
    tokenSet.value = (await api.credentialGet(form.value.platform)) !== null;
  } catch (e) {
    tokenSet.value = null;
    reportError(String(e));
  }
}

function startAdd() {
  editing.value = true;
  editId.value = null;
  form.value = { platform: "gitea", host: "", label: "" };
  tokenInput.value = "";
  tokenSet.value = null;
}

function startEdit(entry: ConnectionEntry) {
  editing.value = true;
  editId.value = entry.id;
  form.value = { platform: entry.platform, host: entry.host, label: entry.label };
  tokenInput.value = "";
  void probeToken();
}

function onPlatformChange() {
  tokenInput.value = "";
  void probeToken();
}

async function save() {
  if (!form.value.host.trim() || !form.value.label.trim()) return;
  try {
    if (!ghManaged.value && tokenInput.value.trim()) {
      await api.credentialSet(form.value.platform, tokenInput.value.trim());
    }
    const saved = await api.connectionSave({
      id: editId.value ?? undefined,
      platform: form.value.platform,
      host: form.value.host.trim(),
      label: form.value.label.trim(),
    });
    pushToast({ kind: "success", message: t("conn.saved", { label: saved.label }) });
    editing.value = false;
    await load();
  } catch (e) {
    reportError(String(e));
  }
}

async function removeConnection(entry: ConnectionEntry) {
  try {
    await api.connectionDelete(entry.id);
    await load();
  } catch (e) {
    reportError(String(e));
  }
}

function close() {
  emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") close();
}
onMounted(() => {
  void load();
  document.addEventListener("keydown", onKeydown);
});
// 卸载时清理（onBeforeUnmount 由宿主保证；这里用组件卸载钩子等价实现）
import { onBeforeUnmount } from "vue";
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="conn-overlay" @click.self="close">
    <div class="conn-panel" role="dialog" :aria-label="t('conn.title')">
      <div class="conn-head">
        <span class="conn-title">{{ t("conn.title") }}</span>
        <button class="conn-close" @click="close">✕</button>
      </div>

      <template v-if="!editing">
        <p v-if="connections.length === 0" class="conn-empty">{{ t("conn.empty") }}</p>
        <ul class="conn-list">
          <li v-for="c in connections" :key="c.id" class="conn-item">
            <span class="conn-icon"><EditorIcon :name="c.platform === 'github' ? 'issue.detail' : c.platform === 'gitea' ? 'terminal' : c.platform === 'gitee' ? 'issue.list' : 'settings'" /></span>
            <span class="conn-label">{{ c.label }}</span>
            <span class="conn-host">{{ c.host }}</span>
            <span class="conn-state" :class="{ ok: true }">{{ t("conn.credSet") }}</span>
            <button class="conn-btn" @click="startEdit(c)">{{ t("conn.edit") }}</button>
            <button class="conn-btn danger" @click="removeConnection(c)">{{ t("conn.delete") }}</button>
          </li>
        </ul>
        <button class="conn-add" @click="startAdd">{{ t("conn.add") }}</button>
      </template>

      <template v-else>
        <div class="form-row">
          <label class="form-label">{{ t("conn.type") }}</label>
          <select v-model="form.platform" class="form-select" @change="onPlatformChange">
            <option v-for="p in PLATFORMS" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </div>
        <div class="form-row">
          <label class="form-label">{{ t("conn.labelField") }}</label>
          <input v-model.trim="form.label" class="form-input" :placeholder="t('conn.labelPlaceholder')" />
        </div>
        <div class="form-row">
          <label class="form-label">{{ t("conn.hostField") }}</label>
          <input
            v-model.trim="form.host"
            class="form-input"
            :placeholder="form.platform === 'github' ? 'github.com' : 'https://gitea.example.com'"
            spellcheck="false"
          />
        </div>
        <div class="form-row">
          <label class="form-label">{{ t("conn.tokenField") }}</label>
          <input
            v-if="!ghManaged"
            v-model="tokenInput"
            class="form-input"
            type="password"
            autocomplete="off"
            :placeholder="t('conn.tokenPlaceholder')"
          />
          <span v-else class="form-note">{{ t("conn.ghManaged") }}</span>
        </div>
        <div class="conn-actions">
          <button class="conn-btn" @click="editing = false">{{ t("conn.cancel") }}</button>
          <button class="conn-btn primary" :disabled="!form.host.trim() || !form.label.trim()" @click="save">
            {{ t("conn.save") }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.conn-overlay {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.conn-panel {
  width: 520px;
  max-width: calc(100vw - 40px);
  max-height: 75vh;
  overflow: auto;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 14px 16px;
}
.conn-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.conn-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
}
.conn-close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 12px;
}
.conn-close:hover {
  color: var(--text);
}
.conn-empty {
  font-size: 12px;
  color: var(--text-dim);
  text-align: center;
  padding: 16px 0;
}
.conn-list {
  list-style: none;
  margin: 0 0 10px;
  padding: 0;
}
.conn-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 6px;
  font-size: 12px;
}
.conn-label {
  font-weight: 600;
  color: var(--text);
}
.conn-host {
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
}
.conn-state {
  margin-left: auto;
  font-size: 10px;
  color: var(--success);
  white-space: nowrap;
}
.conn-btn {
  flex: none;
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  font-size: 11px;
  height: 22px;
  padding: 0 8px;
  border-radius: 5px;
  cursor: pointer;
}
.conn-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.conn-btn.danger:hover {
  border-color: var(--danger);
  color: var(--danger);
}
.conn-add {
  width: 100%;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  height: 28px;
  border-radius: 6px;
  cursor: pointer;
}
.conn-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 9px;
}
.form-label {
  width: 90px;
  flex: none;
  font-size: 12px;
  color: var(--text);
}
/* 下拉与输入框同款扁平样式；select 必须 appearance:none，
   否则 macOS 画原生渐变/立体外观（此前踩过）。 */
.form-select,
.form-input {
  appearance: none;
  -webkit-appearance: none;
  flex: 1;
  box-sizing: border-box;
  font-size: 12px;
  color: var(--text);
  background-color: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 5px;
  height: 26px;
  padding: 0 8px;
  outline: none;
}
.form-select {
  padding-right: 24px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' fill='none' stroke='%239aa0a8' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 8px;
}
[data-theme="light"] .form-select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' fill='none' stroke='%23656d76' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
}
.form-input:focus,
.form-select:focus {
  border-color: var(--accent);
}
.form-note {
  font-size: 12px;
  color: var(--text-dim);
}
.conn-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.conn-btn.primary {
  background: var(--bg-selected);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}
</style>
