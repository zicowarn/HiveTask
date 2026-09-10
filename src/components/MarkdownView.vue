<script setup lang="ts">
/**
 * Render GitHub-flavoured markdown text from issue/PR bodies.
 *
 * Security: markdown-it runs with html:false, so raw HTML in remote content
 * is escaped rather than injected; the rendered string is safe for v-html.
 * HTML comments are stripped first to match GitHub, where bodies routinely
 * carry a <!-- PR checklist --> block that never shows in the rendered view.
 * All links are forced through a new, noopener tab.
 */
import { computed } from "vue";
import MarkdownIt from "markdown-it";
import { stripHtmlComments } from "./markdown";

const props = defineProps<{ source?: string | null }>();

const md = new MarkdownIt({
  html: false,
  breaks: true, // GitHub treats single newlines in bodies as line breaks
  linkify: true,
});

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const rendered = computed(() => md.render(stripHtmlComments(props.source ?? "")));
</script>

<template>
  <div class="markdown-body" v-html="rendered"></div>
</template>

<style scoped>
.markdown-body {
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
  word-wrap: break-word;
}
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 18px 0 8px;
  line-height: 1.3;
  font-weight: 600;
}
.markdown-body :deep(h1) {
  font-size: 19px;
}
.markdown-body :deep(h2) {
  font-size: 17px;
}
.markdown-body :deep(h3) {
  font-size: 15px;
}
.markdown-body :deep(p) {
  margin: 8px 0;
}
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 8px 0;
  padding-left: 22px;
}
.markdown-body :deep(li) {
  margin: 3px 0;
}
.markdown-body :deep(li > ul),
.markdown-body :deep(li > ol) {
  margin: 3px 0;
}
.markdown-body :deep(a) {
  color: var(--accent);
  text-decoration: none;
}
.markdown-body :deep(a:hover) {
  text-decoration: underline;
}
.markdown-body :deep(blockquote) {
  margin: 8px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--border);
  color: var(--text-dim);
}
.markdown-body :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
}
.markdown-body :deep(pre) {
  margin: 10px 0;
  padding: 10px 12px;
  background: var(--bg-app);
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow-x: auto;
}
.markdown-body :deep(pre code) {
  padding: 0;
  border: none;
  background: none;
  font-size: 12px;
  line-height: 1.5;
}
.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 10px 0;
  font-size: 12px;
  display: block;
  overflow-x: auto;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--border);
  padding: 5px 10px;
}
.markdown-body :deep(th) {
  background: var(--bg-hover);
  font-weight: 600;
}
.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--border);
  margin: 14px 0;
}
.markdown-body :deep(img) {
  max-width: 100%;
}
.markdown-body > :deep(:first-child) {
  margin-top: 0;
}
.markdown-body > :deep(:last-child) {
  margin-bottom: 0;
}
</style>
