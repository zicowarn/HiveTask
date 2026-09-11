<script setup lang="ts">
/**
 * In-window menubar, the successor of QHiveFrame's self-drawn QMenuBar
 * (which lived in the app header via QMainWindow::setMenuWidget — no
 * native menubar there either). Pure presentation: menus arrive fully
 * resolved from the host, items are plain callbacks.
 *
 * Interaction: click opens, moving across top-level labels switches while
 * a menu is open, click-outside / Esc / item activation closes. Each
 * dropdown is a SIBLING of its label button (never nested inside it) — a
 * button-inside-button both violates the HTML spec and lets the item click
 * bubble back into toggle(), instantly reopening the menu.
 */
import { onBeforeUnmount, onMounted, ref } from "vue";

export interface MenuItemDef {
  label?: string;
  shortcut?: string;
  action?: () => void;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
}

export interface MenuDef {
  label: string;
  items: MenuItemDef[];
}

defineProps<{ menus: MenuDef[] }>();

const openIndex = ref<number | null>(null);
const rootEl = ref<HTMLElement | null>(null);

function toggle(index: number): void {
  openIndex.value = openIndex.value === index ? null : index;
}
function hover(index: number): void {
  if (openIndex.value !== null && openIndex.value !== index) openIndex.value = index;
}
function run(item: MenuItemDef): void {
  if (item.disabled || item.separator) return;
  item.action?.();
  openIndex.value = null;
}
function onDocPointerDown(event: MouseEvent): void {
  if (openIndex.value === null) return;
  if (rootEl.value && !rootEl.value.contains(event.target as Node)) openIndex.value = null;
}
function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") openIndex.value = null;
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocPointerDown);
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocPointerDown);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <nav ref="rootEl" class="app-menu">
    <div v-for="(menu, index) in menus" :key="menu.label" class="menu">
      <button
        class="menu-label"
        :class="{ open: openIndex === index }"
        @click="toggle(index)"
        @mouseenter="hover(index)"
      >
        {{ menu.label }}
      </button>
      <div v-if="openIndex === index" class="menu-dropdown">
        <template v-for="(item, itemIndex) in menu.items" :key="itemIndex">
          <div v-if="item.separator" class="menu-separator"></div>
          <button
            v-else
            class="menu-item"
            :disabled="item.disabled"
            @click.stop="run(item)"
          >
            <span class="item-check">{{ item.checked ? "✓" : "" }}</span>
            <span class="item-label">{{ item.label }}</span>
            <span v-if="item.shortcut" class="item-shortcut">{{ item.shortcut }}</span>
          </button>
        </template>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.app-menu {
  display: flex;
  align-items: stretch;
  gap: 2px;
  align-self: stretch;
}
.menu {
  position: relative;
  display: flex;
  align-items: stretch;
}
.menu-label {
  display: inline-flex;
  align-items: center;
  border: none;
  background: transparent;
  color: var(--text-dim);
  font-size: 12px;
  padding: 0 9px;
  border-radius: 5px;
  cursor: pointer;
}
.menu-label:hover,
.menu-label.open {
  background: var(--bg-hover);
  color: var(--text);
}
.menu-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 100;
  min-width: 210px;
  padding: 5px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}
.menu-separator {
  height: 1px;
  margin: 5px 6px;
  background: var(--border);
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  height: 26px;
  padding: 0 8px;
  border-radius: 5px;
  cursor: pointer;
  text-align: left;
}
.menu-item:hover:not(:disabled) {
  background: var(--bg-selected);
}
.menu-item:disabled {
  color: var(--text-dim);
  opacity: 0.55;
  cursor: default;
}
.item-check {
  width: 14px;
  flex: none;
  color: var(--accent);
}
.item-label {
  flex: 1;
  white-space: nowrap;
}
.item-shortcut {
  color: var(--text-dim);
  font-size: 11px;
  margin-left: 18px;
}
</style>
