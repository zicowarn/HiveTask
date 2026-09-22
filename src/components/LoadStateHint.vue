<script setup lang="ts">
/**
 * 数据面板三态占位（统一原语）：loading = 骨架脉冲；empty = 居中引导文案；
 * error = 红字 + 重试按钮。三态永不共用一个空白——空与加载中是两种语义。
 * 收编目标：cal-hint / ai-empty / 各面板散点 loading（第二步机械替换）。
 */
import { useI18n } from "../i18n";

defineProps<{
  state: "loading" | "empty" | "error";
  /** empty 态文案（调用方 i18n）。 */
  text?: string;
  /** error 态错误详情（原文折叠展示）。 */
  error?: string;
}>();

defineEmits<{ retry: [] }>();

const { t } = useI18n();
</script>

<template>
  <div class="lsh" :class="`lsh--${state}`">
    <template v-if="state === 'loading'">
      <div class="skeleton lsh-line lsh-line--w60" />
      <div class="skeleton lsh-line lsh-line--w40" />
    </template>
    <p v-else-if="state === 'empty'" class="lsh-text">{{ text }}</p>
    <template v-else>
      <p class="lsh-text lsh-error">{{ t("common.loadFailed") }}</p>
      <p v-if="error" class="lsh-detail">{{ error }}</p>
      <button class="lsh-retry" type="button" @click="$emit('retry')">
        {{ t("common.retry") }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.lsh {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
}
.lsh-line {
  height: 12px;
}
.lsh-line--w60 {
  width: min(60%, 320px);
}
.lsh-line--w40 {
  width: min(40%, 200px);
}
.lsh-text {
  margin: 0;
  font-size: var(--font-md);
  color: var(--text-dim);
  text-align: center;
}
.lsh-error {
  color: var(--danger);
}
.lsh-detail {
  margin: 0;
  max-width: 60ch;
  font-size: var(--font-sm);
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.lsh-retry {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  cursor: pointer;
}
.lsh-retry:hover {
  background: var(--bg-hover);
}
</style>
