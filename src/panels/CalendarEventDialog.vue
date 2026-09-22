<script setup lang="ts">
/**
 * 日程新建/编辑对话框（S4）：标题必填，结束日期/备注/提醒可选。
 * 提醒存 datetime-local 形态；保存「带提醒」的事件时顺带请求一次系统通知
 * 权限（用户手势点，调度器侧永不主动弹框）。删除是危险动作：两击确认。
 * 保存走 calendar store（状态栏与日历面板即时联动）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import DropdownMenu from "../components/DropdownMenu.vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useI18n } from "../i18n";
import { requestNotificationPermission } from "../reminder-scheduler";
import { useCalendarStore } from "../stores/calendar";
import type { CalendarEventRow } from "../api";

const props = defineProps<{
  mode: "create" | "edit";
  /** create 模式的预填起始日期（点击/框选的日期）。 */
  date?: string | null;
  /** edit 模式的既有日程。 */
  event?: CalendarEventRow | null;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();

const store = useCalendarStore();
const { t } = useI18n();

const title = ref(props.mode === "edit" ? (props.event?.title ?? "") : "");
const startDate = ref(props.mode === "edit" ? (props.event?.startDate ?? props.date ?? "") : (props.date ?? ""));
const endDate = ref(props.mode === "edit" ? (props.event?.endDate ?? "") : "");
const allDay = ref(props.mode === "edit" ? (props.event?.allDay ?? true) : true);
const startTime = ref(props.mode === "edit" ? (props.event?.startTime ?? "") : "");
const endTime = ref(props.mode === "edit" ? (props.event?.endTime ?? "") : "");
const notes = ref(props.mode === "edit" ? (props.event?.notes ?? "") : "");
const remindAt = ref(props.mode === "edit" ? (props.event?.remindAt ?? "") : "");
const recur = ref(props.mode === "edit" ? (props.event?.recur ?? "") : "");
const recurOptions = computed(() => [
  { value: "", label: t("calendar.recurNone") },
  { value: "daily", label: t("calendar.recurDaily") },
  { value: "weekly", label: t("calendar.recurWeekly") },
  { value: "monthly", label: t("calendar.recurMonthly") },
  { value: "yearly", label: t("calendar.recurYearlySolar") },
  { value: "lunar", label: t("calendar.recurYearlyLunar") },
]);
/** 选「每周」时预锚起始日的星期（ISO 1=一…7=日）；星期用行内 chips 改。 */
const weekdayChips = computed(() =>
  [1, 2, 3, 4, 5, 6, 7].map((n) => ({
    value: n,
    label: t(`calendar.wd${n}` as import("../i18n").MessageKey),
  })),
);
function onRecurChange(v: string | string[]): void {
  const val = Array.isArray(v) ? String(v[0]) : String(v);
  if (val === "weekly") {
    const base = startDate.value ? new Date(startDate.value) : new Date();
    const iso = base.getDay() === 0 ? 7 : base.getDay();
    recur.value = `weekly:${iso}`;
    return;
  }
  recur.value = val;
}
const titleInput = ref<HTMLInputElement | null>(null);
const error = ref<string | null>(null);
const working = ref(false);
/** 两击确认删除。 */
const armed = ref(false);

onMounted(() => {
  void nextTick(() => {
    titleInput.value?.focus();
    titleInput.value?.select();
  });
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

async function save(): Promise<void> {
  if (working.value) return;
  if (!title.value.trim() || !startDate.value) return;
  if (remindAt.value) void requestNotificationPermission(); // 带提醒才请求；fire-and-forget
  working.value = true;
  error.value = null;
  try {
    if (props.mode === "edit" && props.event) {
      await store.update(
        props.event.id,
        title.value,
        startDate.value,
        endDate.value || null,
        undefined,
        undefined,
        undefined,
        notes.value || null,
        remindAt.value || null,
      );
    } else {
      await store.create(
        title.value,
        startDate.value,
        endDate.value || null,
        undefined,
        undefined,
        undefined,
        notes.value || null,
        remindAt.value || null,
      );
    }
    emit("saved");
    emit("close");
  } catch (e) {
    error.value = String(e);
  } finally {
    working.value = false;
  }
}

async function remove(): Promise<void> {
  if (props.mode !== "edit" || !props.event) return;
  if (!armed.value) {
    armed.value = true;
    return;
  }
  try {
    await store.remove(props.event.id);
    emit("saved");
    emit("close");
  } catch (e) {
    error.value = String(e);
  }
}
</script>

<template>
  <div class="ce-overlay" @click.self="emit('close')">
    <div class="ce-panel" role="dialog" aria-modal="true">
      <header class="ce-head">
        <span class="ce-title">{{ mode === "edit" ? t("calendar.eventEdit") : t("calendar.eventNew") }}</span>
        <button class="ce-close" :title="t('common.close')" @click="emit('close')">
          <EditorIcon name="o.x" />
        </button>
      </header>

      <input
        ref="titleInput"
        v-model="title"
        class="ce-input"
        :placeholder="t('calendar.eventTitlePh')"
        @keydown.enter="save"
      />

      <div class="ce-grid">
        <label class="ce-label">{{ t("calendar.eventStart") }}</label>
        <input v-model="startDate" class="ce-input" type="date" @keydown.enter="save" />
        <label class="ce-label">{{ t("calendar.eventEnd") }}</label>
        <input v-model="endDate" class="ce-input" type="date" @keydown.enter="save" />
        <label class="ce-label">{{ t("calendar.eventAllDay") }}</label>
        <input v-model="allDay" class="setting-check" type="checkbox" />
        <template v-if="!allDay">
          <label class="ce-label">{{ t("calendar.eventStartTime") }}</label>
          <input v-model="startTime" class="ce-input" type="time" @keydown.enter="save" />
          <label class="ce-label">{{ t("calendar.eventEndTime") }}</label>
          <input v-model="endTime" class="ce-input" type="time" @keydown.enter="save" />
        </template>
        <label class="ce-label">{{ t("calendar.eventRecur") }}</label>
        <DropdownMenu :model-value="recur" :options="recurOptions" @update:model-value="onRecurChange" />
        <template v-if="recur.startsWith('weekly')">
          <label class="ce-label">{{ t("calendar.eventWeekday") }}</label>
          <div class="ce-wd">
            <button
              v-for="chip in weekdayChips"
              :key="chip.value"
              class="ce-wd-btn"
              :class="{ on: recur === `weekly:${chip.value}` }"
              type="button"
              @click="recur = `weekly:${chip.value}`"
            >
              {{ chip.label }}
            </button>
          </div>
        </template>
        <label class="ce-label">{{ t("calendar.eventRemind") }}</label>
        <input v-model="remindAt" class="ce-input" type="datetime-local" @keydown.enter="save" />
      </div>

      <input
        v-model="notes"
        class="ce-input"
        :placeholder="t('calendar.eventNotes')"
        @keydown.enter="save"
      />

      <p v-if="error" class="ce-error">{{ error }}</p>

      <footer class="ce-foot">
        <button
          v-if="mode === 'edit'"
          class="text-btn danger"
          :class="{ armed }"
          @click="remove"
        >
          {{ armed ? t("calendar.eventDeleteArm") : t("calendar.eventDelete") }}
        </button>
        <span class="ce-spacer"></span>
        <button class="text-btn" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="text-btn primary" :disabled="working || !title.trim() || !startDate" @click="save">
          {{ t("common.save") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.ce-overlay {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 16vh;
  background: rgba(0, 0, 0, 0.35);
}
.ce-panel {
  width: 420px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 9px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  padding: 14px 16px;
}
.ce-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.ce-title {
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
}
.ce-close {
  border: none;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  padding: 2px;
}
.ce-input {
  display: block;
  width: 100%;
  height: 24px;
  margin-bottom: 8px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  outline: none;
}
.ce-input:focus {
  border-color: var(--accent);
}
.ce-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 10px;
  align-items: center;
  margin-bottom: 8px;
}
.ce-grid .ce-input {
  margin-bottom: 0;
}
.ce-label {
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.ce-wd {
  display: flex;
  gap: 4px;
  align-items: center;
}
.ce-wd-btn {
  min-width: 24px;
  height: 22px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-xs);
  cursor: pointer;
}
.ce-wd-btn.on {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.ce-error {
  font-size: var(--font-sm);
  color: var(--danger);
  margin: 6px 0 0;
}
.ce-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.ce-spacer {
  flex: 1;
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
