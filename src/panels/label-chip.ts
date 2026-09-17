/**
 * 标签 chip 着色（对齐 GitHub 线上设计）：标签主题色作底、文字按底色
 * 亮度自动取黑/白保证可读。hex 归一容错（gh 不带 #、Gitea 带 #；非法
 * 值返回 undefined 回退应用默认 chip 样式）。
 */
import type { CSSProperties } from "vue";

export function hexNorm(color?: string | null): string | null {
  if (!color) return null;
  const hex = color.startsWith("#") ? color.slice(1) : color;
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex}` : null;
}

/** 底色 → chip 内联样式；无色/非法色 → undefined（调用方回退默认样式）。 */
export function chipStyle(color?: string | null): CSSProperties | undefined {
  const hex = hexNorm(color);
  if (!hex) return undefined;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // 感知亮度经验式（ITU-R BT.601 加权），阈值取 GitHub 观感折中值
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return {
    background: hex,
    color: luminance > 140 ? "#1f2328" : "#ffffff",
    borderColor: hex,
  };
}
