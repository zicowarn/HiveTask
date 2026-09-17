<script setup lang="ts">
/**
 * New / Edit option（平台的选项对话框）——改列 / 泳道段 / 字段选项的名称、
 * 颜色、说明。形态对齐 GitHub（平台实测，2× 截图逐像素取值）：
 *   顶栏「New option / Edit option」+ × 分隔线，正文 16px 内边距；
 *   预览区 = 浅底圆角面板（52px），空名称时是 14×20 描边小框，有名称时是
 *   着色 chip；Label text* 32px 输入；Color = 8 个 32px 方块色板（浅底 +
 *   同色圆环，选中态整块填色 + 白勾）；Description 文本域 + 说明文字；
 *   底栏 Cancel（浅底描边）+ Save（绿实心 #1F883D）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "../i18n";
import EditorIcon from "../components/EditorIcon.vue";
import { OPTION_COLORS, tintOf } from "./option-colors";

const props = withDefaults(
  defineProps<{
    open: boolean;
    name: string;
    color: string;
    description?: string | null;
    /** new = 新建选项（标题「New option」），edit = 编辑既有选项。 */
    mode?: "new" | "edit";
  }>(),
  { mode: "edit" },
);
const emit = defineEmits<{
  save: [payload: { name: string; color: string; description: string }];
  cancel: [];
}>();

const { t } = useI18n();

const draftName = ref("");
const draftColor = ref<string>(OPTION_COLORS[0]);
const draftDescription = ref("");
const nameInput = ref<HTMLInputElement | null>(null);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    draftName.value = props.name;
    draftColor.value = props.color || OPTION_COLORS[0];
    draftDescription.value = props.description ?? "";
    // 打开即聚焦「Label text」（平台同款；也避免 × 上出现焦点环）
    void nextTick(() => nameInput.value?.focus());
  },
  { immediate: true },
);

/** Esc 关闭（与应用内其它弹层同口径）。 */
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && props.open) emit("cancel");
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

const title = computed(() =>
  props.mode === "new" ? t("project.optNewTitle") : t("project.optEditTitle"),
);
/** 名称空时不置灰 Save（平台实测：空标签下 Save 仍是绿实心），点按聚焦输入。 */
function save() {
  if (!draftName.value.trim()) {
    nameInput.value?.focus();
    return;
  }
  emit("save", {
    name: draftName.value.trim(),
    color: draftColor.value,
    description: draftDescription.value.trim(),
  });
}
</script>

<template>
  <div v-if="open" class="oe-modal" @click.self="emit('cancel')">
    <div class="oe-card" role="dialog" aria-modal="true">
      <header class="oe-head">
        <p class="oe-title">{{ title }}</p>
        <button class="oe-close" type="button" :title="t('common.close')" @click="emit('cancel')">
          <EditorIcon name="o.x" />
        </button>
      </header>

      <div class="oe-body">
        <!-- 预览区：平台为浅底圆角面板，内容居中 -->
        <p class="oe-preview">
          <span
            v-if="!draftName.trim()"
            class="oe-blank"
            :style="{ borderColor: draftColor }"
          ></span>
          <span
            v-else
            class="oe-chip"
            :style="{ background: tintOf(draftColor), color: draftColor }"
            >{{ draftName }}</span
          >
        </p>

        <label class="oe-field">
          <span class="oe-label">{{ t("project.optLabelText") }}<b>*</b></span>
          <input ref="nameInput" v-model="draftName" class="oe-input" />
        </label>

        <div class="oe-field">
          <span class="oe-label">{{ t("project.optColor") }}</span>
          <div class="oe-colors">
            <button
              v-for="c in OPTION_COLORS"
              :key="c"
              type="button"
              class="oe-swatch"
              :class="{ on: draftColor.toLowerCase() === c }"
              :style="{
                background: draftColor.toLowerCase() === c ? c : tintOf(c),
              }"
              :aria-label="c"
              :aria-pressed="draftColor.toLowerCase() === c"
              @click="draftColor = c"
            >
              <EditorIcon v-if="draftColor.toLowerCase() === c" name="o.check" class="oe-tick" />
              <span v-else class="oe-ring" :style="{ borderColor: c }"></span>
            </button>
          </div>
        </div>

        <label class="oe-field">
          <span class="oe-label">{{ t("project.optDescription") }}</span>
          <textarea v-model="draftDescription" class="oe-input oe-textarea" rows="2"></textarea>
          <span class="oe-hint">{{ t("project.optDescriptionHint") }}</span>
        </label>
      </div>

      <footer class="oe-actions">
        <button class="oe-btn" type="button" @click="emit('cancel')">{{ t("conn.cancel") }}</button>
        <button class="oe-btn primary" type="button" @click="save">{{ t("common.save") }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.oe-modal {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.35);
}
/* 卡片：平台实测宽 320、圆角 6、1px 描边；顶栏 16px 内边距 + 分隔线 */
.oe-card {
  width: 320px;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 16px 32px rgba(0, 0, 0, 0.2);
  overflow: hidden;
}
.oe-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}
.oe-title {
  margin: 0;
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--text);
}
.oe-close {
  display: inline-flex;
  border: none;
  background: transparent;
  color: var(--text-dim);
  padding: 2px;
  border-radius: 5px;
  cursor: pointer;
}
.oe-close:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.oe-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}
/* 预览区：浅底面板（平台 #F6F8FA = 本应用 light --bg-app），高 52 */
.oe-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 52px;
  margin: 0;
  border-radius: 6px;
  background: var(--bg-app);
}
/* 空名称 = 小描边圆角框（平台实测 14×20、圆角 5、1px 边框） */
.oe-blank {
  width: 14px;
  height: 20px;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 5px;
}
/* 有名称 = 着色 chip（浅底 + 同色文字） */
.oe-chip {
  padding: 1px 10px;
  border-radius: 999px;
  font-size: var(--font-md);
  font-weight: 600;
}
.oe-field {
  display: flex;
  flex-direction: column;
}
.oe-label {
  margin-bottom: 8px;
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--text);
}
.oe-label b {
  color: var(--danger);
}
.oe-input {
  box-sizing: border-box;
  height: 32px;
  width: 100%;
  font-size: var(--font-lg);
  font-family: inherit;
  color: var(--text);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 12px;
  outline: none;
}
.oe-input:focus {
  border-color: var(--accent);
}
.oe-textarea {
  height: auto;
  min-height: 46px;
  line-height: 20px;
  padding: 3px 12px;
  resize: vertical;
}
.oe-hint {
  margin-top: 8px;
  font-size: var(--font-md);
  color: var(--text-dim);
}
/* 色板：8 个 32px 方块（浅底 + 同色圆环；选中 = 整块填色 + 白勾） */
.oe-colors {
  display: flex;
  gap: 4px;
}
.oe-swatch {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}
.oe-swatch:hover {
  box-shadow: inset 0 0 0 2px var(--border);
}
.oe-ring {
  width: 16px;
  height: 16px;
  box-sizing: border-box;
  border: 2px solid currentColor;
  border-radius: 50%;
}
.oe-tick {
  color: #fff;
}
.oe-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 0 16px 16px;
}
.oe-btn {
  height: 32px;
  padding: 0 13px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-lg);
  font-family: inherit;
  cursor: pointer;
}
.oe-btn:hover {
  border-color: var(--text-dim);
}
/* Save：平台绿实心（实测 #20883D / 规范值 #1F883D） */
.oe-btn.primary {
  background: var(--btn-primary);
  border-color: var(--btn-primary-border);
  color: #fff;
}
.oe-btn.primary:hover {
  background: var(--btn-primary-hover);
}
</style>
