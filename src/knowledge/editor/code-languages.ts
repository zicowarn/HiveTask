/**
 * 代码文件的语言路由：扩展名 → CM6 语言扩展。
 *
 * 只收录**有官方 CM6 语言包**的格式（markdown/js/css/html 由既有依赖带进树，
 * 其余是显式依赖）；其余扩展名返回 null —— 编辑器仍可用（纯文本编辑 + 行号），
 * 只是没有着色。不引 prism-legacy 之类的流式高亮兜底：那些包要么年久失修要么
 * 带 WKWebView 兼容性风险，收益撑不起体积。
 */
import type { Extension } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { cpp } from "@codemirror/lang-cpp";
import { rust } from "@codemirror/lang-rust";
import { java } from "@codemirror/lang-java";

/** 扩展名 → 语言工厂（小写、不含点）。 */
const LANGUAGE_FACTORIES: Record<string, () => Extension> = {
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  mts: () => javascript({ typescript: true }),
  cts: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
  json5: () => json(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  html: () => html(),
  htm: () => html(),
  vue: () => html(),
  xml: () => html(),
  svg: () => html(),
  md: () => markdown(),
  markdown: () => markdown(),
  py: () => python(),
  pyw: () => python(),
  rs: () => rust(),
  c: () => cpp(),
  h: () => cpp(),
  cpp: () => cpp(),
  cc: () => cpp(),
  cxx: () => cpp(),
  hpp: () => cpp(),
  java: () => java(),
};

/** 代码文件可能有语言的扩展名集合（不含 Markdown —— 那走专用编辑器路径）。 */
export const CODE_LANGUAGES: ReadonlySet<string> = new Set(Object.keys(LANGUAGE_FACTORIES));

/** 扩展名 → 语法高亮扩展；不认识的返回 null（纯文本编辑，不打折）。 */
export function codeLanguageFor(ext: string): Extension | null {
  const factory = LANGUAGE_FACTORIES[ext.toLowerCase()];
  return factory ? factory() : null;
}
