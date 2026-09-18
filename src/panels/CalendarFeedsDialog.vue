<script setup lang="ts">
/**
 * 日历订阅管理对话框（S3-b）：列表（名称/状态/刷新/删除/显示开关）+ 添加表单。
 * 提示里写清 Google/Outlook 取「私密地址 iCal」与 RRULE v1 口径。
 * 删除是危险动作：两击确认（先变红「确认删除」再执行）。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import { api, type CalendarFeed } from "../api";
import { useI18n } from "../i18n";

const emit = defineEmits<{ close: []; changed: [] }>();
const { t } = useI18n();

const feeds = ref<CalendarFeed[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const name = ref("");
const url = ref("");
const working = ref(false);
const syncingId = ref<string | null>(null);
/** 两击确认删除：已武装的订阅 id。 */
const armedId = ref<string | null>(null);

onMounted(() => {
  void load();
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    feeds.value = await api.calendarFeedList();
    emit("changed");
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function add(): Promise<void> {
  if (!name.value.trim() || !url.value.trim() || working.value) return;
  working.value = true;
  error.value = null;
  try {
    await api.calendarFeedAdd(name.value, url.value);
    name.value = "";
    url.value = "";
    await load();
  } catch (e) {
    error.value = String(e);
  } finally {
    working.value = false;
  }
}

async function sync(feed: CalendarFeed): Promise<void> {
  if (syncingId.value) return;
  syncingId.value = feed.id;
  error.value = null;
  try {
    await api.calendarFeedSync(feed.id);
    await load();
  } catch (e) {
    error.value = String(e);
  } finally {
    syncingId.value = null;
  }
}

async function toggle(feed: CalendarFeed): Promise<void> {
  try {
    await api.calendarFeedSetEnabled(feed.id, !feed.enabled);
    await load();
  } catch (e) {
    error.value = String(e);
  }
}

async function remove(feed: CalendarFeed): Promise<void> {
  if (armedId.value !== feed.id) {
    armedId.value = feed.id;
    return;
  }
  armedId.value = null;
  try {
    await api.calendarFeedRemove(feed.id);
    await load();
  } catch (e) {
    error.value = String(e);
  }
}

function syncState(feed: CalendarFeed): string {
  if (syncingId.value === feed.id) return t("common.syncing");
  if (!feed.lastSyncedAt) return t("calendar.feedNever");
  const count = feed.cachedCount ?? 0;
  return `${t("calendar.feedLastSync", { time: feed.lastSyncedAt })} · ${t("calendar.feedEvents", { n: count })}`;
}
</script>

<template>
  <div class="cal-feeds-overlay" @click.self="emit('close')">
    <div class="cal-feeds-panel" role="dialog" aria-modal="true">
      <header class="cf-head">
        <span class="cf-title">{{ t("calendar.feedsTitle") }}</span>
        <button class="cf-close" :title="t('common.close')" @click="emit('close')">
          <EditorIcon name="o.x" />
        </button>
      </header>

      <p class="cf-hint">{{ t("calendar.feedHint") }}</p>

      <p v-if="loading" class="cf-note">{{ t("common.loadingFull") }}</p>
      <p v-else-if="feeds.length === 0" class="cf-note">{{ t("calendar.feedEmpty") }}</p>
      <ul v-else class="cf-list">
        <li v-for="feed in feeds" :key="feed.id" class="cf-row" :class="{ off: !feed.enabled }">
          <label class="cf-show">
            <input type="checkbox" :checked="feed.enabled" @change="toggle(feed)" />
            <span>{{ t("calendar.feedEnabled") }}</span>
          </label>
          <div class="cf-main">
            <span class="cf-name">{{ feed.name }}</span>
            <span class="cf-meta">{{ syncState(feed) }}</span>
          </div>
          <button class="text-btn" :disabled="syncingId !== null" @click="sync(feed)">
            {{ syncingId === feed.id ? t("common.syncing") : t("calendar.feedSyncNow") }}
          </button>
          <button
            class="text-btn danger"
            :class="{ armed: armedId === feed.id }"
            @click="remove(feed)"
          >
            {{ armedId === feed.id ? t("calendar.feedDeleteArm") : t("calendar.feedDelete") }}
          </button>
        </li>
      </ul>

      <div class="cf-add">
        <input v-model="name" class="cf-input" :placeholder="t('calendar.feedNamePh')" />
        <input
          v-model="url"
          class="cf-input cf-url"
          :placeholder="t('calendar.feedUrlPh')"
          @keydown.enter="add"
        />
        <button class="text-btn primary" :disabled="working || !name.trim() || !url.trim()" @click="add">
          {{ t("calendar.feedAdd") }}
        </button>
      </div>

      <p v-if="error" class="cf-error">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.cal-feeds-overlay {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 16vh;
  background: rgba(0, 0, 0, 0.35);
}
.cal-feeds-panel {
  width: 520px;
  max-height: 70vh;
  overflow: auto;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 9px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  padding: 14px 16px;
}
.cf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.cf-title {
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.cf-close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  padding: 2px;
}
.cf-hint,
.cf-note {
  font-size: var(--font-sm);
  color: var(--text-dim);
  margin: 0 0 10px;
  line-height: 1.5;
}
.cf-list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
}
.cf-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
  border-bottom: 1px solid var(--border);
}
.cf-row.off .cf-main {
  opacity: 0.55;
}
.cf-show {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-xs);
  color: var(--text-dim);
  flex: none;
}
.cf-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.cf-name {
  font-size: var(--font-md);
  color: var(--text);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cf-meta {
  font-size: var(--font-xs);
  color: var(--text-dim);
}
.cf-add {
  display: flex;
  gap: 6px;
  align-items: center;
}
.cf-input {
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  padding: 0 7px;
  outline: none;
  min-width: 0;
}
.cf-input:focus {
  border-color: var(--accent);
}
.cf-url {
  flex: 1;
}
.cf-error {
  font-size: var(--font-sm);
  color: var(--danger);
  margin: 8px 0 0;
}
.text-btn {
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  border-radius: 6px;
  height: 22px;
  padding: 0 8px;
  font-size: var(--font-md);
  cursor: pointer;
  flex: none;
}
.text-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.text-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.text-btn.danger {
  color: var(--danger);
}
.text-btn.danger.armed {
  background: var(--danger);
  border-color: var(--danger);
  color: #fff;
}
.text-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
