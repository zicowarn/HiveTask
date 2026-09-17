<script setup lang="ts">
// 内容组件（不含遮罩）：外壳由 App.vue 用与「切换仓库 / 切换项目」共享的
// overlay + panel 渲染——三处入口形态与实现同源。
// 仅保留 Esc 关闭：Esc 是全局键，与外壳无关。
import { onBeforeUnmount, onMounted } from "vue";
import EditorIcon from "../components/EditorIcon.vue";
import { useI18n } from "../i18n";
import { useKnowledgeStore } from "../stores/knowledge";

const emit = defineEmits<{ close: [] }>();
const store = useKnowledgeStore();
const { t } = useI18n();

async function pick(): Promise<void> {
  const picked = await store.pickRoot();
  if (picked) emit("close");
}

async function choose(path: string): Promise<void> {
  await store.setRoot(path);
  emit("close");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="kb-body">
    <button class="kb-pick" @click="pick">
      <EditorIcon name="o.file-directory" />
      <span>{{ t("kb.pickRoot") }}</span>
    </button>

    <div class="kb-section">{{ t("kb.recent") }}</div>
    <p v-if="store.recent.length === 0" class="kb-empty">{{ t("kb.recentEmpty") }}</p>
    <ul v-else class="kb-list">
      <li v-for="path in store.recent" :key="path" class="kb-row" :class="{ current: path === store.root }">
        <button class="kb-row-main" :title="path" @click="choose(path)">
          <EditorIcon name="o.file-directory-fill" />
          <span class="kb-row-name">{{ path }}</span>
        </button>
        <button class="kb-row-del" :title="t('kb.forget')" @click="store.forget(path)">
          <EditorIcon name="o.x" />
        </button>
      </li>
    </ul>

  </div>
</template>

<style scoped>
.kb-body {
  display: block;
}
.kb-pick {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: 100%;
  height: 32px;
  margin: 2px 0 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  font-weight: 600;
  cursor: pointer;
}
.kb-pick:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.kb-section {
  font-size: var(--font-sm);
  color: var(--text-dim);
  padding: 0 2px 6px;
}
.kb-empty {
  margin: 2px 2px 8px;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.kb-list {
  list-style: none;
  margin: 0 0 8px;
  padding: 0;
}
.kb-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 6px;
}
.kb-row:hover {
  background: var(--bg-hover);
}
.kb-row.current {
  background: var(--bg-selected);
}
.kb-row-main {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 6px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-md);
  text-align: left;
  cursor: pointer;
}
.kb-row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
}
.kb-row-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-right: 4px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.kb-row-del:hover {
  background: var(--bg-app);
  color: var(--danger);
}
</style>
