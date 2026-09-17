<script setup lang="ts">
/**
 * 右侧抽屉原语（平台 Side panel 的桌面形态）——「Add items to project」与
 * 将来的 task 编辑抽屉共用：遮罩 + 右侧滑出面板 + 头部（标题/关闭/可选动作）
 * + 主体插槽 + 底部插槽；Esc 与点遮罩关闭由本组件统一处理。
 */
import { onBeforeUnmount, onMounted, ref } from "vue";
import EditorIcon from "./EditorIcon.vue";
import { useI18n } from "../i18n";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** 面板宽度（平台约 480px）。 */
    width?: string;
    /** 遮罩顶部偏移（如应用 header 高度 "44px"，让出全局 chrome）。 */
    top?: string;
    /** 浮层面板形态：四周留白 + 圆角 + 投影（平台 side panel 同款）。 */
    floating?: boolean;
    /** 关闭前是否询问（例如有未提交内容时由调用方决定，这里预留）。 */
    closeDisabled?: boolean;
  }>(),
  { width: "480px", top: "0", floating: false, closeDisabled: false },
);

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const root = ref<HTMLElement | null>(null);

function requestClose() {
  if (props.closeDisabled) return;
  emit("close");
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && props.open) requestClose();
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sd-overlay" :style="{ top }" @click.self="requestClose">
      <aside
        ref="root"
        class="sd-panel"
        :class="{ floating }"
        role="complementary"
        :aria-label="title"
        :style="{ width }"
      >
        <header class="sd-head">
          <h3 class="sd-title">{{ title }}</h3>
          <div class="sd-head-actions">
            <slot name="header-actions" />
            <button
              class="sd-icon-btn"
              type="button"
              :title="t('common.close')"
              :aria-label="t('common.close')"
              @click="requestClose"
            >
              <EditorIcon name="o.x" />
            </button>
          </div>
        </header>
        <div class="sd-body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="sd-foot">
          <slot name="footer" />
        </footer>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.sd-overlay {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, 0.28);
}
.sd-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-panel);
  border-left: 1px solid var(--border);
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.22);
  min-width: 0;
}
/* 浮层面板（平台 side panel 实测几何）：顶/右/底三边贴边（高 = workspace），
   仅左侧留缝；左上圆角可见，贴边角自然切平 */
.sd-panel.floating {
  height: 100%;
  margin: 0;
  border-radius: 12px 0 0 12px;
  box-shadow: -12px 0 32px rgba(0, 0, 0, 0.22);
}
.sd-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.sd-title {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: var(--font-base);
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sd-head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.sd-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--text-dim);
  border-radius: 6px;
  cursor: pointer;
}
.sd-icon-btn:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.sd-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
}
.sd-foot {
  flex: none;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
