/**
 * 卡片字段 chip 的配色（平台实测量，2026-09-16 取证自
 * github.com/users/zicowarn/projects/13 的卡片 DOM）：
 *
 * 平台 chip 用 Primer 语义三元组内联样式，选项色（八色）→ 语义色的映射由平台
 * 自己写在 `style` 里（如 RED → `--bgColor-danger-muted` / `--fgColor-danger` /
 * `--borderColor-danger-muted`）。八组的解析值取自平台 :root 的 CSS 变量，
 * 见下表；非八色（本地取色器自选色）按 RGB 距离归一到最近一组。
 *
 * 几何（同一份取证）：height 20px、padding 1px 6px、radius 9999px、
 * font-size 12px/600、border-width 1px；数字/文本/日期字段无选项色 → neutral 组。
 */

export interface ChipColors {
  /** 文字色（--fgColor-<semantic>）。 */
  fg: string;
  /** 底色（--bgColor-<semantic>-muted）。 */
  bg: string;
  /** 描边（--borderColor-<semantic>-muted）。 */
  border: string;
  /** 语义名，便于排查与测试断言。 */
  semantic: string;
}

/** 八色调色板 → Primer 语义三元组（平台 :root 解析值，原样抄录）。 */
const SEMANTIC: Record<string, Omit<ChipColors, "semantic">> = {
  "#59636e": { fg: "#59636e", bg: "#818b981f", border: "#d1d9e0b3" }, // neutral
  "#0969da": { fg: "#0969da", bg: "#ddf4ff", border: "#54aeff66" }, // accent
  "#1a7f37": { fg: "#1a7f37", bg: "#dafbe1", border: "#4ac26b66" }, // success
  "#9a6700": { fg: "#9a6700", bg: "#fff8c5", border: "#d4a72c66" }, // attention
  "#bc4c00": { fg: "#bc4c00", bg: "#fff1e5", border: "#fb8f4466" }, // severe
  "#d1242f": { fg: "#d1242f", bg: "#ffebe9", border: "#ff818266" }, // danger
  "#bf3989": { fg: "#bf3989", bg: "#ffeff7", border: "#ff80c866" }, // sponsors
  "#8250df": { fg: "#8250df", bg: "#fbefff", border: "#c297ff66" }, // done
};

/** neutral（灰）组：数字/文本/日期字段的 chip，平台也给这一组。 */
export const NEUTRAL_CHIP: ChipColors = { ...SEMANTIC["#59636e"]!, semantic: "neutral" };

function parseHex(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const SEMANTIC_NAMES: Record<string, string> = {
  "#59636e": "neutral",
  "#0969da": "accent",
  "#1a7f37": "success",
  "#9a6700": "attention",
  "#bc4c00": "severe",
  "#d1242f": "danger",
  "#bf3989": "sponsors",
  "#8250df": "done",
};

/** 选项色（十六进制）→ chip 三元组。空色或无法解析 → neutral。 */
export function chipColors(color: string | null | undefined): ChipColors {
  if (!color) return NEUTRAL_CHIP;
  const key = color.trim().toLowerCase().startsWith("#") ? color.trim().toLowerCase() : `#${color.trim().toLowerCase()}`;
  const exact = SEMANTIC[key];
  if (exact) return { ...exact, semantic: SEMANTIC_NAMES[key]! };
  // 自选色：RGB 距离归一到最近一档（平台选项本就只有这八色）
  const rgb = parseHex(key);
  if (!rgb) return NEUTRAL_CHIP;
  let best: ChipColors = NEUTRAL_CHIP;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [hex, triple] of Object.entries(SEMANTIC)) {
    const ref = parseHex(hex)!;
    const dist = (rgb[0] - ref[0]) ** 2 + (rgb[1] - ref[1]) ** 2 + (rgb[2] - ref[2]) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = { ...triple, semantic: SEMANTIC_NAMES[hex]! };
    }
  }
  return best;
}
