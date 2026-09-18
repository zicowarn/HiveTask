<script setup lang="ts">
/**
 * 转换并另存为其他编码（头部「编码」菜单的第二项）。
 *
 * 与"以此编码重新打开"的区别（这是这个功能存在的意义）：
 * - **重新打开**只改解读方式，文件字节不动；
 * - **转换并另存为**按目标编码**写出一个副本** —— 原件保持不变（编码转换不可逆，
 *   默认不覆盖是最安全的口径；要原地转码：状态栏切编码 + ⌘S，那条路有 mtime 冲突保护）。
 *
 * 内容来源：Markdown 用**编辑器当前内容**（含未保存改动，界面里明说）；其余格式从磁盘
 * 按当前解读编码重读 —— 与"你看到的就是写出去的"一致。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import { api } from "../api";
import { useI18n } from "../i18n";
import { useKnowledgeStore } from "../stores/knowledge";
import DropdownMenu from "../components/DropdownMenu.vue";

const props = defineProps<{
  /** 源文件的根内相对路径。 */
  rel: string;
  /** 源文件的原始文本（Markdown 传编辑器内容；其余传磁盘读到的文本）。 */
  text: string;
  /** 当前的解读编码（界面上显示"从 X 转换"）。 */
  sourceEncoding: string;
  /** 当前换行风格（跟随源文件）。 */
  eol: string;
  /** 源文件是否有 BOM（副本沿用，避免"转完多了 BOM"的意外）。 */
  bom: boolean;
}>();
const emit = defineEmits<{ close: []; done: [rel: string] }>();

const store = useKnowledgeStore();
const { t } = useI18n();

/** 目标编码候选（与状态栏一致；当前编码置顶但标注"同当前"）。 */
const TARGETS = ["UTF-8", "GB18030", "GBK", "BIG5", "Shift_JIS", "EUC-KR", "UTF-16LE", "UTF-16BE"];
const encodingOptions = computed(() =>
  TARGETS.map((name) => ({
    value: name,
    label: name === props.sourceEncoding ? `${name}（同当前）` : name,
  })),
);
const encoding = ref(props.sourceEncoding === "UTF-8" ? "GB18030" : "UTF-8");

/** 默认新文件名：`原名-编码.后缀`（在后缀前插，保留原后缀让系统仍用对的程序打开）。 */
const defaultName = ((): string => {
  const base = props.rel.split("/").pop() ?? props.rel;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const tag = encoding.value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${stem}-${tag}${ext}`;
})();
const name = ref(defaultName);

/** 目标目录 = 源文件所在目录（另存为通常就在旁边）。 */
const dir = computed(() => (props.rel.includes("/") ? props.rel.slice(0, props.rel.lastIndexOf("/")) : ""));

const input = ref<HTMLInputElement | null>(null);
const error = ref<string | null>(null);
const working = ref(false);

onMounted(() => {
  void nextTick(() => {
    input.value?.focus();
    input.value?.select();
  });
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

/** 目标路径（同名会覆盖 —— 所以先查重，不静默盖掉别人的文件）。 */
const targetRel = computed(() => (dir.value ? `${dir.value}/${name.value.trim()}` : name.value.trim()));

async function submit(): Promise<void> {
  if (working.value) return;
  const value = name.value.trim();
  if (!value) {
    error.value = t("kb.nameRequired");
    return;
  }
  if (value.includes("/") || value.includes("\\")) {
    error.value = t("kb.nameInvalid");
    return;
  }
  if (targetRel.value === props.rel) {
    error.value = t("kb.convertSameName");
    return;
  }
  const root = store.root;
  if (!root) return;
  working.value = true;
  error.value = null;
  try {
    // 目标已存在 → 明确拒绝（编码转换是可逆的，但覆盖别人的文件不是）
    const existing = await api.kbStat(root, targetRel.value);
    if (existing.exists) {
      error.value = t("kb.convertExists", { name: value });
      working.value = false;
      return;
    }
    await api.kbWriteText({
      root,
      rel: targetRel.value,
      text: props.text,
      encoding: encoding.value,
      bom: props.bom,
      eol: props.eol,
      // 新文件没有"外部改动"可比对，传 null 跳过 mtime 守卫
      expectedMtimeMs: null,
    });
    await store.refresh(dir.value);
    emit("done", targetRel.value);
    emit("close");
  } catch (e) {
    // 后端在"目标编码表示不了某些字符"时会拒绝 —— 那句话要原样呈现给用户
    error.value = String(e);
  } finally {
    working.value = false;
  }
}
</script>

<template>
  <div class="kb-overlay" @click.self="emit('close')">
    <div class="kb-panel" role="dialog" aria-modal="true">
      <header class="kb-head">
        <span class="kb-title">{{ t("kb.convertTitle") }}</span>
        <button class="kb-close" :title="t('common.close')" @click="emit('close')">
          <EditorIcon name="o.x" />
        </button>
      </header>

      <p class="kb-where">
        <EditorIcon name="o.file-directory-fill" />
        <span class="kb-where-path">{{ dir || t("kb.rootLabel") }}</span>
      </p>

      <div class="kb-row">
        <span class="kb-label">{{ t("kb.convertFrom") }}</span>
        <span class="kb-value">{{ props.sourceEncoding }}</span>
      </div>

      <div class="kb-row">
        <span class="kb-label">{{ t("kb.convertTo") }}</span>
        <DropdownMenu v-model="encoding" :options="encodingOptions" />
      </div>

      <input
        ref="input"
        v-model="name"
        class="kb-input"
        :placeholder="t('kb.fileNamePlaceholder')"
        @keydown.enter="submit"
      />

      <p class="kb-note">{{ t("kb.convertNote") }}</p>
      <p v-if="error" class="kb-error">{{ error }}</p>

      <footer class="kb-foot">
        <button class="text-btn" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="text-btn primary" :disabled="working" @click="submit">
          {{ t("kb.convertSave") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.kb-overlay {
  position: fixed;
  inset: 0;
  z-index: 220;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 18vh;
  background: rgba(0, 0, 0, 0.35);
}
.kb-panel {
  width: 400px;
  max-width: calc(100vw - 40px);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 12px 14px 12px;
}
.kb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
}
.kb-title {
  font-size: var(--font-base);
  font-weight: 700;
  color: var(--text);
}
.kb-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.kb-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.kb-where {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 8px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.kb-where-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.kb-label {
  flex: none;
  width: 56px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.kb-value {
  font-size: var(--font-sm);
  color: var(--text);
}
.kb-input {
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  outline: none;
}
.kb-input:focus {
  border-color: var(--accent);
}
.kb-note {
  margin: 8px 0 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
  line-height: 1.6;
}
.kb-error {
  margin: 6px 0 0;
  font-size: var(--font-sm);
  color: var(--danger, #e5534b);
  line-height: 1.6;
}
.kb-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 10px;
}
</style>
