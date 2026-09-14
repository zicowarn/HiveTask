<script setup lang="ts">
/**
 * About dialog — the successor of QHiveFrame's QHFAboutUsDialog (which the
 * old Help menu opened via the ABOUT_US notification): 420px card with app
 * identity, description, version, license and a third-party list. Modal
 * here instead of modeless — one webview window has no second surface to
 * return to, and Esc/closing restores the workbench immediately.
 */
import { onBeforeUnmount, onMounted } from "vue";
import { useI18n } from "../i18n";
import { APP_VERSION } from "../app-info";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

// Versions are compile-time facts, not translations — kept as plain data.
const libraries = [
  { name: "Vue", detail: "3.x (MIT License)" },
  { name: "Tauri", detail: "2.x (MIT / Apache-2.0)" },
  { name: "Pinia", detail: "3.x (MIT License)" },
  { name: "Vite", detail: "6.x (MIT License)" },
];

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}
onMounted(() => document.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="about-overlay" @click.self="emit('close')">
      <div class="about-card" role="dialog" :aria-label="t('menu.about')">
        <div class="about-identity">
          <span class="about-mark">⬡</span>
          <span class="about-name">HiveTask</span>
        </div>
        <p class="about-description">{{ t("about.description") }}</p>
        <div class="about-rows">
          <div class="about-row">
            <span class="row-label">{{ t("about.version") }}</span>
            <span class="row-value">v{{ APP_VERSION }}</span>
          </div>
          <div class="about-row">
            <span class="row-label">{{ t("about.builtWith") }}</span>
          </div>
          <div class="about-row">
            <span class="row-label">{{ t("about.license") }}</span>
          </div>
        </div>
        <div class="about-libraries">
          <span class="row-label">{{ t("about.libraries") }}</span>
          <ul class="library-list">
            <li v-for="lib in libraries" :key="lib.name">{{ lib.name }} — {{ lib.detail }}</li>
          </ul>
        </div>
        <p class="about-copyright">
          {{ t("about.copyright", { year: new Date().getFullYear() }) }}
        </p>
        <div class="about-actions">
          <button class="about-close" @click="emit('close')">{{ t("about.close") }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.about-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}
.about-card {
  width: 420px;
  max-width: calc(100vw - 40px);
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
  padding: 22px 24px 18px;
}
.about-identity {
  display: flex;
  align-items: baseline;
  gap: 9px;
}
.about-mark {
  color: var(--accent);
  font-size: 22px;
}
.about-name {
  font-size: var(--font-xl);
  font-weight: 700;
  color: var(--text);
}
.about-description {
  margin: 12px 0 0;
  font-size: var(--font-md);
  line-height: 1.6;
  color: var(--text-dim);
}
.about-rows {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.about-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row-label {
  font-size: var(--font-md);
  color: var(--text);
}
.row-value {
  font-size: var(--font-md);
  color: var(--text-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.about-libraries {
  margin-top: 14px;
}
.library-list {
  margin: 6px 0 0;
  padding: 10px 12px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  list-style: none;
  font-size: var(--font-sm);
  line-height: 1.8;
  color: var(--text-dim);
}
.about-copyright {
  margin: 14px 0 0;
  font-size: var(--font-sm);
  color: var(--text-dim);
}
.about-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
.about-close {
  border: 1px solid var(--border);
  background: var(--bg-app);
  color: var(--text);
  font-size: var(--font-md);
  height: 24px;
  padding: 0 16px;
  border-radius: 6px;
  cursor: pointer;
}
.about-close:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
