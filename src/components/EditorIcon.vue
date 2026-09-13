<script setup lang="ts">
/** 14px 内联 SVG 图标（stroke 用 currentColor，随明暗主题与按钮状态变色）。 */
defineProps<{ name: string }>();
</script>

<template>
  <svg
    class="editor-icon"
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'issue.list'">
      <circle cx="3.2" cy="4" r="1" fill="currentColor" stroke="none" />
      <circle cx="3.2" cy="10" r="1" fill="currentColor" stroke="none" />
      <path d="M6 4h6M6 10h6" />
    </template>
    <template v-else-if="name === 'issue.detail'">
      <circle cx="7" cy="7" r="5.4" />
      <circle cx="7" cy="7" r="1.6" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'pull'">
      <circle cx="3.5" cy="3.5" r="1.9" />
      <circle cx="3.5" cy="10.5" r="1.9" />
      <path d="M3.5 5.4v3.2" />
      <circle cx="10.5" cy="10.5" r="1.9" />
      <path d="M10.5 8.6V7a2 2 0 0 0-2-2H5.5" />
    </template>
    <template v-else-if="name === 'pull.detail'">
      <circle cx="3.5" cy="3.5" r="1.9" />
      <circle cx="3.5" cy="10.5" r="1.9" />
      <path d="M3.5 5.4v3.2" />
      <circle cx="10.5" cy="10.5" r="1.9" />
      <path d="M10.5 8.6V7a2 2 0 0 0-2-2H5.5" />
      <path d="M8 3.5h4M10 1.5v4" />
    </template>
    <template v-else-if="name === 'git.history'">
      <circle cx="7" cy="7" r="2.1" />
      <path d="M7 1.2v3.7M7 9.1v3.7" />
    </template>
    <template v-else-if="name === 'terminal'">
      <path d="M2.4 3.4 6 7l-3.6 3.6" />
      <path d="M7.6 10.8H12" />
    </template>
    <template v-else-if="name === 'project.board'">
      <rect x="1.8" y="2.2" width="3.4" height="9.6" rx="0.8" />
      <rect x="6.3" y="2.2" width="3.4" height="6.4" rx="0.8" />
      <rect x="10.8" y="2.2" width="3.4" height="8" rx="0.8" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="7" cy="7" r="2.2" />
      <path d="M7 1.4v2M7 10.6v2M1.4 7h2M10.6 7h2M3 3l1.4 1.4M9.6 9.6 11 11M11 3 9.6 4.4M4.4 9.6 3 11" />
    </template>
    <template v-else-if="name === 'lock'">
      <rect x="3.6" y="6.4" width="6.8" height="4.8" rx="1" />
      <path d="M5.2 6.4V4.7a1.8 1.8 0 0 1 3.6 0v1.7" />
    </template>
    <template v-else-if="name === 'unlock'">
      <rect x="3.6" y="6.4" width="6.8" height="4.8" rx="1" />
      <path d="M5.2 6.4V4.7a1.8 1.8 0 0 1 3.6 0v.9" />
    </template>
  </svg>
</template>

<style scoped>
.editor-icon {
  flex: none;
  display: block;
}
</style>
