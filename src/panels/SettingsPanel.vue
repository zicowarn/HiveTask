<script setup lang="ts">
/**
 * Settings panel — registered as "settings" (see workbench/registry.ts).
 * Hosts the panel chrome and the mode switch (基础设置 today; advanced /
 * shortcuts / data panels are the natural later modes). Preferences
 * themselves live in src/i18n, src/theme.ts and the settings store.
 */
import { computed, ref, watch } from "vue";
import PanelShell from "../workbench/PanelShell.vue";
import ModeTabs from "../components/ModeTabs.vue";
import { resolvePanel } from "../workbench/registry";

defineProps<{ leafId?: string; panelType?: string }>();

const PANEL_TYPE = "settings";
const MODE_STORAGE_KEY = "hivetask.panel-mode.settings";

const def = resolvePanel(PANEL_TYPE);
const modes = def.modes ?? [];

const storedMode =
  modes.find((m) => m.key === localStorage.getItem(MODE_STORAGE_KEY))?.key ?? modes[0]?.key;
const modeKey = ref(storedMode);
watch(modeKey, (key) => localStorage.setItem(MODE_STORAGE_KEY, key));

const activeMode = computed(() => modes.find((m) => m.key === modeKey.value) ?? modes[0]);
</script>

<template>
  <PanelShell :leaf-id="leafId" :panel-type="panelType">
    <template v-if="modes.length > 1" #switcher>
      <ModeTabs v-model="modeKey" :modes="modes" />
    </template>

    <component :is="activeMode.component" />
  </PanelShell>
</template>
