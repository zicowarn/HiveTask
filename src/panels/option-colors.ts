/**
 * 选项可选色——GitHub 的八色选项调色板（取自平台 Edit option 对话框的
 * 色点描边色）。与后端 `OPTION_PALETTE` 是同一套，新建字段时按序轮转。
 */
export const OPTION_COLORS = [
  "#59636e", // GRAY
  "#0969da", // BLUE
  "#1a7f37", // GREEN
  "#9a6700", // YELLOW
  "#bc4c00", // ORANGE
  "#d1242f", // RED
  "#bf3989", // PINK
  "#8250df", // PURPLE
] as const;

/**
 * 色值 → 浅底 token（色板方块的底，平台形态：浅底方块 + 同色圆环，
 * 选中态整块填色 + 白勾）。双主题定义见 styles.css 的 `--tint-*`。
 */
const TINT_VARS: Record<string, string> = {
  "#59636e": "var(--tint-gray)",
  "#0969da": "var(--tint-blue)",
  "#1a7f37": "var(--tint-green)",
  "#9a6700": "var(--tint-yellow)",
  "#bc4c00": "var(--tint-orange)",
  "#d1242f": "var(--tint-red)",
  "#bf3989": "var(--tint-pink)",
  "#8250df": "var(--tint-purple)",
};

export function tintOf(color: string): string {
  return TINT_VARS[color.toLowerCase()] ?? "var(--bg-chip)";
}
