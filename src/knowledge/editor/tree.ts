/**
 * 语法树的唯一取法：**要完整树，不要"可能还差一截"的树**。
 *
 * CM6 的 `syntaxTree(state)` 返回的是当前（可能**未解析完**）的树——解析在后台分块进行。
 * 装饰构建、大纲提取这类"一次性读全量节点"的场景若拿到半截树，就会随机漏掉表格/待办/公式/标题
 * （实测：并行跑测试时 kb-editor-decorations 会间歇性失败，真机上也可能出现"首次打开少渲染"）。
 *
 * `ensureSyntaxTree(state, upto, timeout)` 会同步推进解析到指定位置；给一个较小的超时预算兜底，
 * 拿不到完整树时退回当前树（宁可少渲染一次，也不阻塞输入）。
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export function fullSyntaxTree(state: EditorState, timeoutMs = 200) {
  return ensureSyntaxTree(state, state.doc.length, timeoutMs) ?? syntaxTree(state);
}
