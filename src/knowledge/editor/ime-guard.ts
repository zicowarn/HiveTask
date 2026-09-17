/**
 * IME 组字守卫 —— **逐文件对照移植**自 SoloMD（`src/lib/cm-ime-guard.ts`）。
 *
 * 出处：https://github.com/zhitongblog/solomd （MIT License，Copyright (c) 2026 xiangdong li）
 * 本文件按其 MIT 条款保留署名与许可；我们的改动见下方 `HiveTask 注`。
 *
 * 为什么需要它：ViewPlugin 在**组字过程中**重建 decoration 会拆掉正在输入的那行 DOM，
 * Windows WebView2 会因此静默丢弃当前组字（用户看到"吃字 / 一会能打上一会打不上"，
 * SoloMD issue #108）。修法：组字期间**不重建**，只把现有 decoration 集按本次文档变更
 * `map` 保持位置有效；组字提交（compositionend）后会来一次正常的 docChanged，
 * 那时再重建——冻结只覆盖候选窗打开的那几帧，用户看不见。
 *
 * HiveTask 注：macOS WKWebView 是否同样需要这道守卫，由 T0 spike 实测决定；
 * 逻辑上"组字期间不动 DOM"对所有平台都成立，故默认启用。
 */
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/**
 * 组字中返回按变更映射后的旧集合（调用方直接采用，不重建）；
 * 非组字中返回 null，表示调用方应正常重建。
 */
export function frozenDuringComposition(
  update: ViewUpdate,
  current: DecorationSet,
): DecorationSet | null {
  if (!update.view.composing) return null;
  // 组字期间的变更只可能是组字本身产生的文本替换：映射即可保持位置正确。
  return current.map(update.changes);
}

/** 把守卫挂进 ViewPlugin 的 update 流程：返回 true 表示"本帧不重建"。 */
export function shouldFreeze(update: ViewUpdate): boolean {
  return update.view.composing;
}

/** 便捷导出：给需要 `composing` 状态但拿不到 view 的场景（测试用）。 */
export function isComposingState(state: EditorState): boolean {
  return (state as unknown as { composing?: boolean }).composing === true;
}

export type { Extension, EditorView };
