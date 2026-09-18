/**
 * 代码文件的语法高亮（CM6 HighlightStyle）——**跟着主题 token 走**。
 *
 * 为什么不用 Prism 的主题 CSS：那是为网页展示设计的固定配色，与明暗两套主题不联动；
 * 这里把颜色直接绑到 `--syntax-*` 变量上（styles.css `:root` 按主题各定义一套），
 * 明暗切换零 JS。
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

export const codeHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.moduleKeyword], color: "var(--syntax-keyword)" },
  { tag: [t.name, t.deleted], color: "var(--syntax-name)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syntax-function)" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: "var(--syntax-number)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syntax-string)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syntax-type)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--syntax-definition)" },
  { tag: [t.variableName, t.labelName, t.propertyName], color: "var(--syntax-name)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--syntax-operator)" },
  { tag: [t.meta, t.processingInstruction], color: "var(--syntax-meta)" },
  { tag: [t.invalid], color: "var(--danger)" },
]);

export const codeEditorHighlight = syntaxHighlighting(codeHighlightStyle);
