<script setup lang="ts">
/**
 * 查找/替换条（自绘，不用 CM6 的默认面板）。
 *
 * 为什么自绘：CM6 的默认面板是裸 `input` + 系统按钮、**英文硬编码**，
 * 与本项目的 token / i18n 规范都不一致（用户已指出"过于简陋"）。
 * 这里只借用它的**状态与命令**（setSearchQuery / findNext / …）与**匹配高亮**，
 * 界面完全用我们的组件形态。
 */
import { computed, nextTick, ref, watch } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useI18n } from "../i18n";

export interface FindStatus {
  total: number;
  /** 当前命中序号（1 基；0 = 光标不在任何命中上）。 */
  current: number;
}

const props = defineProps<{
  /** 打开时把焦点放到查找框。 */
  autoFocus?: boolean;
  /** 关闭替换（只读预览：PDF 这类只能查找，不能改内容）。 */
  replaceable?: boolean;
}>();

const emit = defineEmits<{
  /** 查询条件变化（含替换文本与三个开关）。 */
  query: [payload: { search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }];
  next: [];
  previous: [];
  replaceOne: [];
  replaceAll: [];
  close: [];
}>();

const { t } = useI18n();

const findText = ref("");
const replaceText = ref("");
const caseSensitive = ref(false);
const regexp = ref(false);
const wholeWord = ref(false);
const showReplace = ref(false);
const canReplace = computed(() => props.replaceable !== false);
const status = ref<FindStatus>({ total: 0, current: 0 });
const findInput = ref<HTMLInputElement | null>(null);

const invalid = computed(() => regexp.value && !isValidRegexp(findText.value));

function isValidRegexp(pattern: string): boolean {
  if (!pattern) return true;
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function pushQuery(): void {
  emit("query", {
    search: findText.value,
    replace: replaceText.value,
    caseSensitive: caseSensitive.value,
    regexp: regexp.value,
    wholeWord: wholeWord.value,
  });
}

watch([findText, replaceText, caseSensitive, regexp, wholeWord], pushQuery);

watch(
  () => props.autoFocus,
  (value) => {
    if (value) {
      void nextTick(() => {
        findInput.value?.focus();
        findInput.value?.select();
      });
    }
  },
  { immediate: true },
);

/**
 * 导航：**查询为空时不发命令**——CM6 的 findNext/findPrevious 在无有效查询时会去打开
 * 它自己的默认面板（`searchCommand` 的 else 分支），那正是"点下一个却弹出底部原始搜索"的原因。
 * 这里改成：空查询只把焦点放回输入框，等用户先输入。
 */
function go(direction: "next" | "previous"): void {
  if (!findText.value.trim()) {
    findInput.value?.focus();
    return;
  }
  if (direction === "next") emit("next");
  else emit("previous");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    go(event.shiftKey ? "previous" : "next");
  }
}

/** 宿主在每次查询/跳转后回报命中情况。 */
function setStatus(next: FindStatus): void {
  status.value = next;
}

defineExpose({ setStatus, focus: () => findInput.value?.focus(), showReplaceRow: () => (showReplace.value = true) });
</script>

<template>
  <div class="find-bar" role="search">
    <div class="find-row">
      <input
        ref="findInput"
        v-model="findText"
        class="find-input"
        :class="{ invalid }"
        :placeholder="t('kb.findPlaceholder')"
        spellcheck="false"
        @keydown="onKeydown"
      />
      <span class="find-count" :class="{ empty: findText && status.total === 0 }">
        {{ !findText ? "" : status.total === 0 ? t("kb.noResults") : t("kb.matchCount", { current: status.current, total: status.total }) }}
      </span>
      <button class="find-toggle" :class="{ on: caseSensitive }" :title="t('kb.matchCase')" @click="caseSensitive = !caseSensitive">Aa</button>
      <button class="find-toggle" :class="{ on: regexp }" :title="t('kb.useRegexp')" @click="regexp = !regexp">.*</button>
      <button class="find-toggle" :class="{ on: wholeWord }" :title="t('kb.wholeWord')" @click="wholeWord = !wholeWord">W</button>
      <span class="find-sep" />
      <button
        v-if="canReplace"
        class="find-toggle"
        :class="{ on: showReplace }"
        :title="t('kb.replaceOne')"
        @click="showReplace = !showReplace"
      >
        <EditorIcon name="o.arrow-both" />
      </button>
      <button class="find-icon" :title="t('kb.findPrev')" @click="go('previous')">
        <EditorIcon name="o.chevron-up" />
      </button>
      <button class="find-icon" :title="t('kb.findNext')" @click="go('next')">
        <EditorIcon name="o.chevron-down" />
      </button>
      <button class="find-icon" :title="t('common.close')" @click="emit('close')">
        <EditorIcon name="o.x" />
      </button>
    </div>

    <div v-if="showReplace && canReplace" class="find-row">
      <input
        v-model="replaceText"
        class="find-input"
        :placeholder="t('kb.replacePlaceholder')"
        spellcheck="false"
        @keydown="onKeydown"
      />
      <button class="find-btn" @click="emit('replaceOne')">{{ t("kb.replaceOne") }}</button>
      <button class="find-btn" @click="emit('replaceAll')">{{ t("kb.replaceAllLabel") }}</button>
    </div>
  </div>
</template>

<style scoped>
.find-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  min-width: 340px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}
.find-row {
  display: flex;
  align-items: center;
  gap: 4px;
}
.find-input {
  flex: 1;
  min-width: 120px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  outline: none;
}
.find-input:focus {
  border-color: var(--accent);
}
.find-input.invalid {
  border-color: var(--danger);
}
.find-count {
  flex: none;
  min-width: 48px;
  text-align: right;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.find-count.empty {
  color: var(--warning);
}
/* 开关（Aa / .* / W）与图标按钮统一 22px，形态与面板头的 icon-btn 一致 */
.find-toggle,
.find-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  height: 22px;
  min-width: 22px;
  padding: 0 5px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--font-md);
  cursor: pointer;
}
.find-toggle:hover,
.find-icon:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.find-toggle.on {
  background: var(--bg-selected);
  color: var(--accent);
}
.find-sep {
  flex: none;
  width: 1px;
  height: 14px;
  margin: 0 3px;
  background: var(--border);
}
.find-btn {
  flex: none;
  height: 22px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  white-space: nowrap;
  cursor: pointer;
}
.find-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
